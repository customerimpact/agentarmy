import { memo } from 'react';
import type { Node, NodeProps } from '@xyflow/react';

export type BrowserFlowNode = Node<Record<string, never>, 'browser'>;

// Placeholder; implemented by the browser-tiles work stream
function BrowserNodeImpl(_props: NodeProps<BrowserFlowNode>) {
  return <div className="h-full w-full rounded-xl bg-surface" />;
}

export const BrowserNode = memo(BrowserNodeImpl);
