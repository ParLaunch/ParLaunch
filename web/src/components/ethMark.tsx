import React from "react";

/**
 * The ETH diamond glyph — the native gas token of Robinhood Chain. Inline
 * SVG so it needs no external asset and inherits layout like an icon.
 * Tinted in the classic two-tone ether gray; sized to sit inline with text.
 */
export function EthMark({ size = 14, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg
      width={Math.round(size * 0.62)}
      height={size}
      viewBox="0 0 256 417"
      style={{ display: "inline-block", verticalAlign: "-0.12em", ...style }}
      aria-label="ETH"
    >
      <path fill="#343434" d="M127.9 0l-2.8 9.5v275.6l2.8 2.8 127.9-75.6z" />
      <path fill="#8C8C8C" d="M127.9 0L0 212.3l127.9 75.6V154.2z" />
      <path fill="#3C3C3B" d="M127.9 312.2l-1.6 1.9v98.2l1.6 4.6L256 236.6z" />
      <path fill="#8C8C8C" d="M127.9 416.9v-104.7L0 236.6z" />
      <path fill="#141414" d="M127.9 287.9l127.9-75.6-127.9-58.1z" />
      <path fill="#393939" d="M0 212.3l127.9 75.6V154.2z" />
    </svg>
  );
}
