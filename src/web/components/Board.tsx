import { useCallback, useEffect, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type NodeTypes,
  type Viewport,
} from '@xyflow/react';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  persistLayout,
  persistViewport,
  setFlowInstance,
} from '../lib/board-actions';
import { STATUS_META } from '../lib/status';
import { consoleList, isLayoutLocked, lockLayout, unlockLayout, useBoard } from '../lib/store';
import { TerminalNode, type TerminalFlowNode } from './TerminalNode';

const nodeTypes: NodeTypes = { terminal: TerminalNode };

export function Board() {
  const consoles = useBoard((s) => s.consoles);
  const selectedId = useBoard((s) => s.selectedId);
  const [nodes, setNodes, onNodesChange] = useNodesState<TerminalFlowNode>([]);
  const flow = useReactFlow();
  // Captured once: after mount the canvas owns the viewport and only reports it back
  const initialViewport = useRef(useBoard.getState().viewport);

  useEffect(() => {
    setFlowInstance(flow);
    return () => setFlowInstance(null);
  }, [flow]);

  // Mirror the store into React Flow nodes, keeping node objects stable when nothing changed
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return consoleList(consoles).map((c) => {
        const existing = prevById.get(c.id);
        const zIndex = c.id === selectedId ? 10 : 0;
        if (existing && isLayoutLocked(c.id))
          return existing.zIndex === zIndex ? existing : { ...existing, zIndex };
        const { x, y, width, height } = c.layout;
        if (
          existing &&
          existing.position.x === x &&
          existing.position.y === y &&
          existing.width === width &&
          existing.height === height &&
          existing.zIndex === zIndex
        ) {
          return existing;
        }
        return {
          ...existing,
          id: c.id,
          type: 'terminal',
          dragHandle: '.aa-drag-handle',
          position: { x, y },
          width,
          height,
          zIndex,
          data: {},
        } satisfies TerminalFlowNode;
      });
    });
  }, [consoles, selectedId, setNodes]);

  const onMoveEnd = useCallback((_: unknown, viewport: Viewport) => persistViewport(viewport), []);

  return (
    <ReactFlow<TerminalFlowNode>
      data-testid="board"
      nodes={nodes}
      edges={[]}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={(_, node) => lockLayout(node.id)}
      onNodeDragStop={(_, node) => {
        unlockLayout(node.id);
        persistLayout(node.id, { x: node.position.x, y: node.position.y });
      }}
      onPaneClick={() => {
        useBoard.getState().select(null);
        (document.activeElement as HTMLElement | null)?.blur?.();
      }}
      onMoveEnd={onMoveEnd}
      defaultViewport={initialViewport.current ?? { x: 0, y: 0, zoom: 1 }}
      fitView={!initialViewport.current}
      fitViewOptions={{ maxZoom: 1, padding: 0.1 }}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      colorMode="system"
      elementsSelectable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      disableKeyboardA11y
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      zoomOnDoubleClick={false}
      // MIT-licensed, so the corner badge is optional; it sat under the command bar
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="var(--aa-dots)" />
      <MiniMap<TerminalFlowNode>
        pannable
        zoomable
        nodeBorderRadius={6}
        nodeColor={(node) => {
          const status = consoles[node.id]?.status;
          return status ? STATUS_META[status].cssVar : 'var(--aa-idle)';
        }}
      />
      <Controls position="top-left" showInteractive={false} />
    </ReactFlow>
  );
}
