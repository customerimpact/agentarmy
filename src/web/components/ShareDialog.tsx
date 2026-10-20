import { useEffect, useState } from 'react';
import { Check, Copy, Eye, Link2, LoaderCircle, Share2, X } from 'lucide-react';
import { useViewport } from '@xyflow/react';
import { cloudApi, useCloud } from '../lib/cloud';
import { guestsOnline, shareApi, useShare } from '../lib/share';
import { useBoard } from '../lib/store';
import { Modal } from './Modal';

const EXPIRY = [
  { label: '1 hour', hours: 1 },
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: 'Until I stop it', hours: 0 },
];

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid="share-copy"
      onClick={() =>
        void navigator.clipboard.writeText(link).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        })
      }
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[12px] text-fg hover:border-accent/60 hover:text-accent"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy link'}
    </button>
  );
}

// Toolbar "Share": make view-only links, see who is watching, stop sharing
export function ShareDialog() {
  const close = () => useShare.getState().setDialogOpen(false);
  const status = useShare((s) => s.status);
  const cloud = useCloud((s) => s.status);
  const [title, setTitle] = useState('');
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void useShare.getState().load();
    void useCloud.getState().load();
  }, []);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      useShare.getState().receive(await shareApi.create(title.trim() || 'GridHive board', hours || undefined));
      setTitle('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stop = (id: string) =>
    useBoard.getState().askConfirm({
      title: 'Stop sharing this link?',
      message: 'Everyone watching through it is disconnected right away.',
      confirmLabel: 'Stop sharing',
      danger: true,
      onConfirm: () =>
        shareApi
          .revoke(id)
          .then((s) => useShare.getState().receive(s))
          .catch((e: Error) => useBoard.getState().toast(`Could not stop sharing: ${e.message}`)),
    });

  return (
    <Modal title="Share this board" onClose={close} width="max-w-lg" testId="share-dialog">
      <div className="flex items-center gap-3 border-b border-line px-5 pt-4 pb-3">
        <span className="grid size-7 place-items-center rounded-md bg-accent/15 text-accent">
          <Share2 size={14} />
        </span>
        <div>
          <h2 className="text-[15px] font-semibold text-fg">Share this board</h2>
          <p className="text-[12.5px] text-fg-muted">People you send the link to watch it live in their browser, with everyone's pointers.</p>
        </div>
      </div>

      {!cloud?.linked ? (
        <div className="space-y-3 p-5" data-testid="share-signin">
          <p className="text-fg-muted">Sharing goes through your free GridHive account, so first link this computer to it.</p>
          {cloud?.pending ? (
            <p className="text-fg">
              Confirm code <span className="font-mono font-semibold">{cloud.pending.userCode}</span> in your browser…
            </p>
          ) : (
            <button
              type="button"
              onClick={() => void cloudApi.link().then((s) => useCloud.getState().receive(s))}
              className="aa-btn-primary rounded-lg px-3 py-1.5 font-semibold"
            >
              Sign in with GitHub or Google
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4 p-5">
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                data-testid="share-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Name, e.g. Shop rebuild"
                className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-fg outline-none focus:border-accent"
              />
              <select
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                className="rounded-md border border-line bg-surface px-2 py-1.5 text-[12.5px] text-fg"
                aria-label="Link expires after"
              >
                {EXPIRY.map((x) => (
                  <option key={x.label} value={x.hours}>
                    {x.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[12px] text-fg-subtle">
                <Eye size={12} /> View only: they see your agents and terminal text live, and can point and follow, not type or launch.
              </span>
              <button
                type="button"
                data-testid="share-create"
                disabled={busy}
                onClick={() => void create()}
                className="aa-btn-primary inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-semibold disabled:opacity-50"
              >
                {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Link2 size={12} />}
                Create link
              </button>
            </div>
            {error && <p className="text-[12px] text-error">{error}</p>}
            {status?.error && <p className="text-[12px] text-needs">{status.error}</p>}
          </div>

          {(status?.shares.length ?? 0) > 0 && (
            <ul className="divide-y divide-line rounded-lg border border-line" data-testid="share-links">
              {status!.shares.map((s) => (
                <li key={s.id} className="space-y-2 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className={`size-1.5 rounded-full ${s.connected ? 'bg-resting' : 'bg-fg-subtle'}`} title={s.connected ? 'Live' : 'Connecting…'} />
                    <span className="truncate font-medium text-fg">{s.title}</span>
                    <span className="font-mono text-[11px] text-fg-subtle">{s.expiresAt ? `until ${new Date(s.expiresAt).toLocaleString()}` : 'no expiry'}</span>
                    <button type="button" aria-label="Stop sharing" onClick={() => stop(s.id)} className="ml-auto grid size-6 place-items-center rounded text-fg-subtle hover:bg-hover hover:text-error">
                      <X size={13} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input readOnly value={s.link} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 font-mono text-[11px] text-fg-muted" />
                    <CopyLink link={s.link} />
                  </div>
                  <p className="text-[12px] text-fg-muted">
                    {s.guests.length === 0 ? 'Nobody watching yet' : `Watching: ${s.guests.map((g) => g.name).join(', ')}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

// Toolbar: who is watching (avatars) and the Share button
export function SharePresence() {
  const status = useShare((s) => s.status);
  const guests = guestsOnline(status);
  return (
    <div className="flex items-center -space-x-1.5" data-testid="share-presence">
      {guests.slice(0, 5).map((g) => (
        <span
          key={g.dev}
          title={`${g.name} is watching`}
          className="grid size-6 place-items-center rounded-full text-[10.5px] font-bold text-black ring-2 ring-surface"
          style={{ background: g.color }}
        >
          {g.name.charAt(0).toUpperCase()}
        </span>
      ))}
    </div>
  );
}

// Guests' pointers on this board (inside the React Flow provider: board coordinates -> screen)
export function SharePointers() {
  const cursors = useShare((s) => s.cursors);
  const vp = useViewport();
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {Object.values(cursors).map((cur) =>
        cur.c ? (
          <div
            key={cur.dev}
            data-testid="share-pointer"
            className="absolute top-0 left-0 flex items-start transition-transform duration-75"
            style={{ transform: `translate(${cur.c.x * vp.zoom + vp.x}px, ${cur.c.y * vp.zoom + vp.y}px)` }}
          >
            <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden>
              <path d="M1 1l13 7.2-5.6 1.4L5.8 16z" fill={cur.color} stroke="#000" strokeWidth="1" strokeLinejoin="round" />
            </svg>
            <span className="mt-3 -ml-0.5 rounded px-1.5 py-[1px] text-[11px] font-semibold whitespace-nowrap text-black" style={{ background: cur.color }}>
              {cur.name}
            </span>
          </div>
        ) : null,
      )}
    </div>
  );
}
