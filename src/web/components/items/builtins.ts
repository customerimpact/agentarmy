import { ChecklistItem } from './ChecklistItem';
import { KanbanItem } from './KanbanItem';
import { NoteItem } from './NoteItem';
import { registerItemRenderer } from './registry';

// Built-in board items. Other kinds (agent D's 'file') register from their own modules.
registerItemRenderer('note', NoteItem, { label: 'Note', minWidth: 160, minHeight: 100 });
registerItemRenderer('checklist', ChecklistItem, { label: 'Checklist', minWidth: 220, minHeight: 160 });
registerItemRenderer('kanban', KanbanItem, { label: 'Kanban', minWidth: 420, minHeight: 240 });
