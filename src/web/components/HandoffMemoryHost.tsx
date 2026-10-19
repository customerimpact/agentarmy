import { useHandoffMemory } from '../lib/handoff-memory';
import { HandoffDialog } from './HandoffDialog';
import { MemoryPanel } from './MemoryPanel';

// Mounted once in the board shell: the "Hand off to…" dialog and the Project memory panel
export function HandoffMemoryHost() {
  const handoffFrom = useHandoffMemory((s) => s.handoffFrom);
  const memoryOpen = useHandoffMemory((s) => s.memoryOpen);
  return (
    <>
      {handoffFrom && <HandoffDialog key={handoffFrom} fromId={handoffFrom} />}
      {memoryOpen && <MemoryPanel />}
    </>
  );
}
