'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * mock SSE：把一段完整回复按 30–60ms 一 chunk 吐出来，可中途停止。
 * 接后端后整体换成 EventSource / fetch ReadableStream，组件签名不变。
 */

const FIRST_CHUNK_DELAY_MS = 800;
const CHUNK_MIN_MS = 30;
const CHUNK_MAX_MS = 60;
const CHUNK_MIN_CHARS = 2;
const CHUNK_MAX_CHARS = 5;

export type StreamPhase = 'idle' | 'waiting' | 'streaming';

export function useMockStream() {
  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [text, setText] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sent = useRef('');
  const settle = useRef<((partial: string) => void) | null>(null);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => clearTimer, []);

  const finish = useCallback(() => {
    clearTimer();
    setPhase('idle');
    const done = settle.current;
    settle.current = null;
    done?.(sent.current);
  }, []);

  const start = useCallback(
    (full: string, onSettled: (partial: string) => void) => {
      clearTimer();
      sent.current = '';
      settle.current = onSettled;
      setText('');
      setPhase('waiting');

      const step = () => {
        const size =
          CHUNK_MIN_CHARS +
          Math.floor(Math.random() * (CHUNK_MAX_CHARS - CHUNK_MIN_CHARS + 1));
        sent.current = full.slice(0, sent.current.length + size);
        setText(sent.current);
        if (sent.current.length >= full.length) {
          finish();
          return;
        }
        timer.current = setTimeout(
          step,
          CHUNK_MIN_MS + Math.random() * (CHUNK_MAX_MS - CHUNK_MIN_MS),
        );
      };

      timer.current = setTimeout(() => {
        setPhase('streaming');
        step();
      }, FIRST_CHUNK_DELAY_MS);
    },
    [finish],
  );

  return { phase, text, start, stop: finish };
}
