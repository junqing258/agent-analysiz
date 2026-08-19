/** Agent SDK 工具接受的 JSON Schema Draft 2020-12 子集。 */
export type JsonSchema = Record<string, unknown>;

export interface SchemaIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: SchemaIssue[];
}

export class SchemaValidationError extends Error {
  constructor(public readonly issues: SchemaIssue[]) {
    super(`Schema validation failed: ${issues.map((issue) => `${issue.path} ${issue.message}`).join(", ")}`);
    this.name = "SchemaValidationError";
  }
}

/**
 * 验证不可信的工具输入，但不解析 Schema 扩展。刻意忽略未知关键字，
 * 以便提供方保留用于展示的元数据。
 */
export function validateJsonSchema(schema: JsonSchema, value: unknown): ValidationResult {
  const issues: SchemaIssue[] = [];
  validate(schema, value, "$", issues);
  return { valid: issues.length === 0, issues };
}

/** 校验输入；不通过时抛出包含所有失败项的异常。 */
export function assertJsonSchema(schema: JsonSchema, value: unknown): void {
  const result = validateJsonSchema(schema, value);
  if (!result.valid) throw new SchemaValidationError(result.issues);
}

/** 按值的运行时类型递归应用当前 Schema 支持的约束。 */
function validate(schema: JsonSchema, value: unknown, path: string, issues: SchemaIssue[]): void {
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issues.push({ path, message: "must equal one of the allowed values" });
    return;
  }
  if ("const" in schema && !Object.is(schema.const, value)) {
    issues.push({ path, message: "must equal the constant value" });
    return;
  }
  const declaredType = schema.type;
  if (typeof declaredType === "string" && !matchesType(declaredType, value)) {
    issues.push({ path, message: `must be ${declaredType}` });
    return;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      issues.push({ path, message: `must have at least ${schema.minLength} characters` });
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      issues.push({ path, message: `must have at most ${schema.maxLength} characters` });
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))
      issues.push({ path, message: "must match required pattern" });
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      issues.push({ path, message: `must be >= ${schema.minimum}` });
    if (typeof schema.maximum === "number" && value > schema.maximum)
      issues.push({ path, message: `must be <= ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      issues.push({ path, message: `must contain at least ${schema.minItems} items` });
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      issues.push({ path, message: `must contain at most ${schema.maxItems} items` });
    const itemSchema = schema.items;
    if (isSchema(itemSchema)) value.forEach((item, index) => validate(itemSchema, item, `${path}[${index}]`, issues));
  }
  if (isRecord(value)) validateObject(schema, value, path, issues);
}

/** 校验对象的必填字段、已声明属性及额外属性限制。 */
function validateObject(schema: JsonSchema, value: Record<string, unknown>, path: string, issues: SchemaIssue[]): void {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  for (const key of required) if (!(key in value)) issues.push({ path: `${path}.${key}`, message: "is required" });
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, childSchema] of Object.entries(properties)) {
    if (key in value && isSchema(childSchema)) validate(childSchema, value[key], `${path}.${key}`, issues);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value))
      if (!(key in properties)) issues.push({ path: `${path}.${key}`, message: "is not allowed" });
  }
}

/** 判断值是否符合 Schema 声明的基础类型；未知类型不在此处拒绝。 */
function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

/** 判断值是否为可作为 JSON 对象处理的普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断值是否可递归用作子 Schema。 */
function isSchema(value: unknown): value is JsonSchema {
  return isRecord(value);
}
