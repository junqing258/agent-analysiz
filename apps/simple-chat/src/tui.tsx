import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, render, Text, useApp, useCursor, useInput, useStdin, type DOMElement } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { stdin, stdout } from "node:process";
import type { AgentMessage, AgentSession, TransportEvent } from "@agent-sdk/core";
import type { DiagnosticLogger } from "./debug.js";

interface ChatMessage {
  id: string;
  role: "you" | "assistant" | "system";
  text: string;
}

export interface TerminalChatOptions {
  session: AgentSession;
  providerLabel: string;
  resumedMessages: number;
  diagnosticLogger?: DiagnosticLogger;
}

/** React-powered Ink chat interface for one persistent AgentSession. */
export class TerminalChat {
  constructor(private readonly options: TerminalChatOptions) {}

  async start(): Promise<void> {
    if (!stdin.isTTY || !stdout.isTTY)
      throw new Error("Simple Chat TUI requires an interactive terminal.");
    const app = render(<ChatApp options={this.options} />, {
      exitOnCtrlC: false,
      incrementalRendering: true,
      maxFps: 30,
    });
    await app.waitUntilExit();
  }
}

function ChatApp({ options }: { options: TerminalChatOptions }): React.JSX.Element {
  const { exit } = useApp();
  const { setCursorPosition } = useCursor();
  const { stdin: inkStdin } = useStdin();
  const terminalHeight = Math.max(8, stdout.rows || 24);
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    toChatMessages(options.session.getMessages()),
  );
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [status, setStatus] = useState(
    options.resumedMessages
      ? `Resumed ${options.resumedMessages} message(s) · ready`
      : "Ready",
  );
  const [busy, setBusy] = useState(false);
  const activeTurn = useRef<AbortController | undefined>(undefined);
  const historyRef = useRef<ScrollViewRef>(null);
  const composerRef = useRef<DOMElement>(null);
  const [composerPosition, setComposerPosition] = useState({ left: 0, top: 0 });

  useEffect(() => {
    const remeasureHistory = () => historyRef.current?.remeasure();
    stdout.on("resize", remeasureHistory);
    return () => stdout.off("resize", remeasureHistory);
  }, []);

  useEffect(() => {
    if (followingLatest) historyRef.current?.scrollToBottom();
  }, [followingLatest, messages]);

  useEffect(() => {
    const layout = composerRef.current?.yogaNode?.getComputedLayout();
    if (!layout) return;
    setComposerPosition((current) =>
      current.left === layout.left && current.top === layout.top
        ? current
        : { left: layout.left, top: layout.top },
    );
  }, [busy, input, messages, terminalHeight]);

  // Position the physical cursor relative to the composer's calculated Yoga
  // layout, rather than assuming the message list has a fixed height.
  setCursorPosition(
    busy
      ? undefined
      : {
          x: composerPosition.left + 2 + displayWidth(input.slice(0, cursor)),
          y: composerPosition.top + 2,
        },
  );

  const eraseBackward = useCallback(() => {
    if (cursor <= 0) return;
    setInput((current) => current.slice(0, cursor - 1) + current.slice(cursor));
    setCursor((current) => current - 1);
  }, [cursor]);

  const eraseForward = useCallback(() => {
    setInput((current) => current.slice(0, cursor) + current.slice(cursor + 1));
  }, [cursor]);

  const close = useCallback(() => {
    activeTurn.current?.abort(new Error("Chat closed"));
    exit();
  }, [exit]);

  useEffect(() => () => activeTurn.current?.abort(new Error("Chat closed")), []);

  const appendSystemMessage = useCallback((text: string) => {
    setMessages((current) => [
      ...current,
      { id: `system-${Date.now()}`, role: "system", text },
    ]);
  }, []);

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setCursor(0);
    setFollowingLatest(true);

    if (text === "/exit" || text === "/quit") return close();
    if (text === "/help") {
      appendSystemMessage(
        "Commands: /help, /clear, /exit. Up/Down scrolls, PgUp/PgDn pages, Home/End jumps; Ctrl-C or Ctrl-D exits.",
      );
      return;
    }
    if (text === "/clear") {
      setMessages([]);
      setFollowingLatest(true);
      setStatus("Screen cleared; conversation history is still retained.");
      return;
    }

    const assistantId = `assistant-${Date.now()}`;
    const controller = new AbortController();
    activeTurn.current = controller;
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: "you", text },
      { id: assistantId, role: "assistant", text: "" },
    ]);
    setBusy(true);
    setStatus("Assistant is thinking…");
    try {
      for await (const event of options.session.run(text, {
        signal: controller.signal,
      })) {
        if (event.type === "model.text.delta") {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, text: message.text + event.text }
                : message,
            ),
          );
        } else if (event.type === "session.state.changed") {
          setStatus(statusForState(event.state));
          options.diagnosticLogger?.("agent.event", {
            type: event.type,
            state: event.state,
          });
        } else if (event.type === "turn.failed") {
          setMessages((current) => replaceMessage(current, assistantId, `Error: ${event.error.message}`));
          setStatus("Turn failed");
        } else if (event.type === "turn.interrupted") {
          setStatus(`Turn interrupted: ${event.reason}`);
        } else {
          options.diagnosticLogger?.("agent.event", { type: event.type });
        }
      }
      setMessages((current) => replaceEmptyMessage(current, assistantId, "(No text response.)"));
      if (!controller.signal.aborted) setStatus("Ready");
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessages((current) =>
          replaceMessage(
            current,
            assistantId,
            `Error: ${error instanceof Error ? error.message : "Unknown failure"}`,
          ),
        );
        setStatus("Turn failed");
      }
    } finally {
      if (activeTurn.current === controller) activeTurn.current = undefined;
      setBusy(false);
    }
  }, [appendSystemMessage, busy, close, input, options]);

  useEffect(() => {
    const handleRawInput = (data: { toString(encoding?: string): string }) => {
      if (busy) return;
      const sequence = data.toString("utf8");
      if (sequence === "\u007F" || sequence === "\b") eraseBackward();
      else if (/^\u001B\[3(?:;\d+)?~$/.test(sequence)) eraseForward();
    };
    inkStdin.on("data", handleRawInput);
    return () => inkStdin.off("data", handleRawInput);
  }, [busy, eraseBackward, eraseForward, inkStdin]);

  useInput((keyInput, key) => {
    if ((key.ctrl && keyInput === "c") || (key.ctrl && keyInput === "d")) {
      close();
      return;
    }
    if (key.return) {
      void submit();
      return;
    }
    if (key.upArrow) {
      setFollowingLatest(false);
      historyRef.current?.scrollBy(-1);
      return;
    }
    if (key.downArrow) {
      historyRef.current?.scrollBy(1);
      return;
    }
    if (key.pageUp) {
      setFollowingLatest(false);
      historyRef.current?.scrollBy(-(historyRef.current.getViewportHeight() || 1));
      return;
    }
    if (key.pageDown) {
      historyRef.current?.scrollBy(historyRef.current.getViewportHeight() || 1);
      return;
    }
    if (key.home) {
      setFollowingLatest(false);
      historyRef.current?.scrollToTop();
      return;
    }
    if (key.end) {
      historyRef.current?.scrollToBottom();
      return;
    }
    if (busy) return;
    if (key.leftArrow) {
      setCursor((current) => Math.max(0, current - 1));
    } else if (key.rightArrow) {
      setCursor((current) => Math.min(input.length, current + 1));
    } else if (key.ctrl && keyInput === "u") {
      setInput("");
      setCursor(0);
    } else if (!key.ctrl && !key.meta && keyInput) {
      setInput((current) => current.slice(0, cursor) + keyInput + current.slice(cursor));
      setCursor((current) => current + keyInput.length);
    }
  });

  return (
    <Box flexDirection="column" height={terminalHeight} width="100%">
      <Box paddingX={1} backgroundColor="blue">
        <Text bold color="white" wrap="truncate-end">
          Simple Chat · {options.providerLabel}
        </Text>
      </Box>
      <Box paddingX={1}>
        <Text color="cyan" dimColor={status === "Ready"} wrap="truncate-end">
          {status}
        </Text>
      </Box>
      <ScrollView
        ref={historyRef}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        paddingX={1}
        onScroll={(offset) =>
          setFollowingLatest(offset >= (historyRef.current?.getBottomOffset() ?? 0))
        }
      >
        {messages.map((message) => (
          <MessageView key={message.id} message={message} />
        ))}
      </ScrollView>
      <Box
        ref={composerRef}
        borderStyle="round"
        borderColor={busy ? "yellow" : "green"}
        height={3}
        minHeight={3}
        flexShrink={0}
        paddingX={1}
      >
        <Box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="flex-start">
          <Composer value={input} cursor={cursor} busy={busy} />
        </Box>
      </Box>
      <Box paddingX={1} backgroundColor="blue">
        <Text color="white" dimColor wrap="truncate-end">
          {busy
            ? "Generating… ↑/↓ scroll · Ctrl-C exits"
            : "Enter send · ↑/↓ scroll · PgUp/PgDn page · Home/End ends · Ctrl-C exit"}
        </Text>
      </Box>
    </Box>
  );
}

function MessageView({ message }: { message: ChatMessage }): React.JSX.Element {
  const label = message.role === "you" ? "You" : message.role === "assistant" ? "Assistant" : "System";
  const color = message.role === "you" ? "yellow" : message.role === "assistant" ? "green" : "cyan";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={color}>{label}</Text>
      <Text wrap="wrap">{message.text || "…"}</Text>
    </Box>
  );
}

function Composer({ value, cursor, busy }: { value: string; cursor: number; busy: boolean }): React.JSX.Element {
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  return (
    <Text color={busy ? "gray" : "white"} wrap="truncate-end">
      {busy ? "Assistant is responding…" : <>{before}<Text color="green">▏</Text>{after}</>}
    </Text>
  );
}

function toChatMessages(messages: readonly AgentMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    const text = message.content
      .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    if (!text || message.role === "system" || message.role === "tool") return [];
    return [{
      id: message.id,
      role: message.role === "user" ? "you" : "assistant",
      text,
    }];
  });
}

function replaceMessage(messages: ChatMessage[], id: string, text: string): ChatMessage[] {
  return messages.map((message) => message.id === id ? { ...message, text } : message);
}

function replaceEmptyMessage(messages: ChatMessage[], id: string, text: string): ChatMessage[] {
  return messages.map((message) => message.id === id && !message.text ? { ...message, text } : message);
}

function statusForState(state: string): string {
  return state === "streaming"
    ? "Assistant is responding…"
    : state === "building-context"
      ? "Preparing context…"
      : state === "completed"
        ? "Ready"
        : state.replace(/-/g, " ");
}

function displayWidth(value: string): number {
  return [...value].reduce(
    (width, character) => width + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uffef]/u.test(character) ? 2 : 1),
    0,
  );
}
