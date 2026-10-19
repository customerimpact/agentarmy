import { lazy, Suspense, type ComponentProps } from 'react';
import { Mic } from 'lucide-react';

// Dictation UI + engines load as their own chunk; until then a plain (inactive) mic button shows
const Button = lazy(() => import('./DictationButton').then((m) => ({ default: m.DictationButton })));

export function DictationButton(props: ComponentProps<typeof Button>) {
  return (
    <Suspense
      fallback={
        <span aria-hidden className="grid size-8 shrink-0 place-items-center text-fg-muted">
          <Mic size={15} />
        </span>
      }
    >
      <Button {...props} />
    </Suspense>
  );
}
