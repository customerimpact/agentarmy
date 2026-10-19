import { memo, useCallback, useEffect, useReducer } from 'react';
import { NodeResizer, useStore, type Node, type NodeProps } from '@xyflow/react';
import { persistItemLayout } from '../../lib/board-actions';
import { itemsApi, updateItemData, useItems } from '../../lib/items';
import { lockLayout, unlockLayout, useBoard } from '../../lib/store';
import { getItemRenderer, onRegistryChange } from './registry';
import './builtins';

export type ItemFlowNode = Node<Record<string, never>, 'item'>;

const DEFAULT_MIN = { width: 160, height: 100 };

function ItemNodeImpl({ id }: NodeProps<ItemFlowNode>) {
  const item = useItems((s) => s.items[id]);
  const selected = useBoard((s) => s.selectedIds.includes(id));
  // Rounded so items re-render on zoom steps, not on every frame of a zoom gesture
  const zoom = useStore((s) => Math.round(s.transform[2] * 20) / 20);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onRegistryChange(rerender), []);

  const setData = useCallback((data: Record<string, unknown>) => updateItemData(id, data), [id]);
  const remove = useCallback(() => {
    void itemsApi
      .remove(id)
      .then(() => useItems.getState().removeItem(id))
      .catch((error: Error) => useBoard.getState().toast(`Delete failed: ${error.message}`));
  }, [id]);

  if (!item) return null;
  const entry = getItemRenderer(item.kind);
  const min = { width: entry?.options.minWidth ?? DEFAULT_MIN.width, height: entry?.options.minHeight ?? DEFAULT_MIN.height };
  const Component = entry?.component;

  return (
    <>
      <div
        data-testid={`item-${item.kind}`}
        data-item-id={id}
        className={`aa-node relative h-full w-full rounded-xl text-left ${selected ? 'ring-2 ring-accent/80' : ''}`}
      >
        {Component ? (
          <Component item={item} selected={selected} zoom={zoom} setData={setData} remove={remove} />
        ) : (
          <div className="aa-drag-handle grid h-full w-full cursor-grab place-items-center rounded-xl border border-line bg-surface text-[12px] text-fg-subtle">
            Unknown item: {item.kind}
          </div>
        )}
      </div>
      <NodeResizer
        minWidth={min.width}
        minHeight={min.height}
        isVisible={selected}
        lineClassName="!border-transparent"
        handleClassName="!size-2 !rounded-sm !border-accent !bg-surface"
        onResizeStart={() => lockLayout(id)}
        onResizeEnd={(_, params) => {
          unlockLayout(id);
          persistItemLayout(id, params);
        }}
      />
    </>
  );
}

export const ItemNode = memo(ItemNodeImpl);
