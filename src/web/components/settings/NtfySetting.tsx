import { useMemo, useState } from 'react';
import { Dices, QrCode, Send } from 'lucide-react';
import type { NtfyTopic } from '../../../shared/protocol';
import { api } from '../../lib/api';
import { encodeQr, qrPath } from '../../lib/qr';
import { useServerSettings } from '../../lib/settings';
import { useBoard } from '../../lib/store';
import { Note, SmallButton } from './fields';

// Settings › Notifications › Phone (ntfy). The topic is the only secret: whoever knows it can
// read the pushes, so we generate a long random one and the server only reports its last 4 chars.

const DEFAULT_SERVER = 'https://ntfy.sh';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomTopic(length = 16): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  // 62 symbols: the tiny modulo bias is irrelevant for a 95-bit topic
  return `agentarmy-${Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
}

const toast = (message: string) => useBoard.getState().toast(message);

function QrImage({ text }: { text: string }) {
  const matrix = useMemo(() => encodeQr(text), [text]);
  if (!matrix) return null;
  const dim = matrix.size + 8;
  return (
    <svg
      data-testid="ntfy-qr"
      viewBox={`0 0 ${dim} ${dim}`}
      width={148}
      height={148}
      role="img"
      aria-label={`QR code for ${text}`}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-md"
    >
      <rect width={dim} height={dim} fill="#ffffff" />
      <path d={qrPath(matrix)} fill="#000000" />
    </svg>
  );
}

function Subscribe({ info, onHide }: { info: NtfyTopic; onHide?: () => void }) {
  return (
    <div data-testid="ntfy-subscribe" className="mt-2 flex gap-3 rounded-md border border-line bg-surface-2 p-2">
      <QrImage text={info.url} />
      <div className="min-w-0 text-[11.5px] leading-4 text-fg-muted">
        <p className="font-medium text-fg">Subscribe on your phone</p>
        <p className="mt-1">Install the free ntfy app, then scan this code or add the topic by hand.</p>
        <a
          data-testid="ntfy-link"
          href={info.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 block truncate font-mono text-accent hover:underline"
          title={info.url}
        >
          {info.url}
        </a>
        <p className="mt-1.5">Keep the topic private: anyone who knows it can read these messages.</p>
        {onHide && (
          <button type="button" onClick={onHide} className="mt-1.5 text-fg-subtle hover:text-fg">
            Hide
          </button>
        )}
      </div>
    </div>
  );
}

function Editor({ initialServer, onDone, onCancel }: { initialServer: string; onDone: (info: NtfyTopic) => void; onCancel?: () => void }) {
  const [topic, setTopic] = useState('');
  const [server, setServer] = useState(initialServer === DEFAULT_SERVER ? '' : initialServer);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const t = topic.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const data = await useServerSettings.getState().patch({ ntfyTopic: t, ntfyServer: server.trim() });
      toast('Phone notifications on');
      const url = `${data.ntfy.server.replace(/\/+$/, '')}/${t}`;
      onDone({ topic: t, server: data.ntfy.server, url });
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const input = `h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2 font-mono text-[12px] text-fg outline-none
                 placeholder:text-fg-subtle focus:border-accent`;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <input
          aria-label="ntfy topic"
          data-testid="ntfy-topic-input"
          value={topic}
          placeholder="Topic, e.g. gridhive-…"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
          className={input}
        />
        <SmallButton testId="ntfy-generate" onClick={() => setTopic(randomTopic())}>
          <Dices size={12} />
          Generate
        </SmallButton>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          aria-label="ntfy server"
          data-testid="ntfy-server-input"
          value={server}
          placeholder={`${DEFAULT_SERVER} (or your own server)`}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setServer(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
          className={input}
        />
        <button
          type="button"
          data-testid="ntfy-save"
          disabled={!topic.trim() || busy}
          onClick={() => void save()}
          className="h-7 shrink-0 rounded-md bg-accent px-2.5 text-[12px] font-semibold text-accent-fg disabled:opacity-30
                     hover:brightness-110"
        >
          Save
        </button>
      </div>
      {onCancel && (
        <button type="button" onClick={onCancel} className="self-start text-[11.5px] text-fg-subtle hover:text-fg">
          Cancel
        </button>
      )}
    </div>
  );
}

export function NtfyBelow() {
  const info = useServerSettings((s) => s.data?.ntfy);
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [subscribe, setSubscribe] = useState<NtfyTopic | null>(null);
  if (!info) return <span className="text-[11.5px] text-fg-subtle">Loading…</span>;

  const sendTest = async () => {
    setTesting(true);
    try {
      await api.testNtfy();
      toast('Test push sent to your phone');
    } catch (e) {
      toast(`ntfy test failed: ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };
  const reveal = async () => {
    try {
      setSubscribe(await api.ntfyTopic());
    } catch (e) {
      toast(`Could not load the topic: ${(e as Error).message}`);
    }
  };
  const remove = async () => {
    try {
      await useServerSettings.getState().patch({ ntfyTopic: '' });
      setSubscribe(null);
      toast('Phone notifications off');
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`);
    }
  };

  const note = (
    <Note>
      Tapping a push opens this board at 127.0.0.1, which only works on this computer. On the phone it is a
      heads-up to come back to your desk.
    </Note>
  );

  if (!info.set || editing) {
    return (
      <>
        <Editor
          initialServer={info.server}
          onDone={(t) => {
            setEditing(false);
            setSubscribe(t);
          }}
          onCancel={editing ? () => setEditing(false) : undefined}
        />
        {note}
      </>
    );
  }
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span data-testid="ntfy-status" className="mr-auto inline-flex min-w-0 items-center gap-1.5 truncate text-[12px] text-fg-muted">
          <span className="size-1.5 shrink-0 rounded-full bg-resting" />
          On
          <span className="font-mono text-fg-subtle">••••{info.hint}</span>
          {info.server !== DEFAULT_SERVER && <span className="truncate font-mono text-fg-subtle">· {info.server}</span>}
        </span>
        <SmallButton testId="test-ntfy" disabled={testing} onClick={() => void sendTest()}>
          <Send size={12} />
          Test
        </SmallButton>
        <SmallButton testId="ntfy-show-qr" onClick={() => (subscribe ? setSubscribe(null) : void reveal())}>
          <QrCode size={12} />
          QR
        </SmallButton>
        <SmallButton onClick={() => setEditing(true)}>Change</SmallButton>
        <SmallButton tone="danger" onClick={() => void remove()}>
          Remove
        </SmallButton>
      </div>
      {subscribe && <Subscribe info={subscribe} onHide={() => setSubscribe(null)} />}
      {note}
    </>
  );
}
