import { useEffect, useRef } from 'react';

type LogStreamProps = {
  lines: string[];
};

const STDERR_PREFIX = '!';

export function LogStream({ lines }: LogStreamProps) {
  const endRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll whenever a line is appended
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);

  if (lines.length === 0) {
    return <pre className="log-stream log-empty">Waiting for output…</pre>;
  }

  return (
    <pre className="log-stream">
      {lines.map((line, idx) => {
        const isErr = line.startsWith(STDERR_PREFIX);
        const text = isErr ? line.slice(STDERR_PREFIX.length) : line;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: log lines are append-only and never reordered
          <div key={idx} className={isErr ? 'log-line log-err' : 'log-line'}>
            {text}
          </div>
        );
      })}
      <div ref={endRef} />
    </pre>
  );
}
