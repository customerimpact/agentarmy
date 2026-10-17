// xterm maps mouse events to cells with getBoundingClientRect (which includes the canvas
// CSS scale) divided by the unscaled cell size, so selection drifts whenever the board
// zoom isn't 1. We rewrite clientX/Y in the capture phase into unscaled coordinates.

const MOUSE_EVENTS = [
  'mousedown',
  'mousemove',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
];

let dragScreen: HTMLElement | null = null;

function screenFor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest('.xterm')?.querySelector<HTMLElement>('.xterm-screen') ?? null;
}

function handle(event: Event): void {
  const e = event as MouseEvent;
  // While a selection drag is in progress xterm listens on the document, so keep the screen
  const screen = e.type === 'mousedown' ? screenFor(e.target) : (dragScreen ?? screenFor(e.target));
  if (e.type === 'mousedown') dragScreen = screen;
  if (e.type === 'mouseup') dragScreen = null;
  if (!screen || !screen.offsetWidth) return;

  const rect = screen.getBoundingClientRect();
  const scale = rect.width / screen.offsetWidth;
  if (!scale || Math.abs(scale - 1) < 0.001) return;

  const clientX = rect.left + (e.clientX - rect.left) / scale;
  const clientY = rect.top + (e.clientY - rect.top) / scale;
  Object.defineProperty(e, 'clientX', { value: clientX, configurable: true });
  Object.defineProperty(e, 'clientY', { value: clientY, configurable: true });
}

let installed = false;

export function installZoomMouseFix(): void {
  if (installed) return;
  installed = true;
  for (const type of MOUSE_EVENTS) window.addEventListener(type, handle, { capture: true });
}
