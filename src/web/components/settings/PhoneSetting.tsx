import { useEffect, useState } from 'react';
import { LoaderCircle, QrCode, Smartphone, TriangleAlert, X } from 'lucide-react';
import type { PhonePairInfo } from '../../../shared/protocol';
import { phoneAccessApi, usePhoneAccess } from '../../lib/phone-access';
import { formatSince } from '../../lib/status';
import { useBoard } from '../../lib/store';
import { Toggle } from './fields';

const toast = (message: string) => useBoard.getState().toast(message);

export function PhoneAccessControl() {
  const status = usePhoneAccess((s) => s.status);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void usePhoneAccess.getState().load();
  }, []);
  const toggle = async () => {
    if (!status || busy) return;
    setBusy(true);
    try {
      usePhoneAccess.getState().receive(await phoneAccessApi.setEnabled(!status.enabled));
    } catch (e) {
      toast(`Could not switch phone access: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span data-testid="phone-access-toggle">
      <Toggle checked={!!status?.enabled} onChange={() => void toggle()} label="Phone on this Wi-Fi" disabled={!status || busy} />
    </span>
  );
}

export function PhoneAccessBelow() {
  const status = usePhoneAccess((s) => s.status);
  const [pair, setPair] = useState<PhonePairInfo | null>(null);
  const [pairing, setPairing] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  // A new phone just paired with the code on screen: hide the QR
  const deviceCount = status?.devices.length ?? 0;
  const [devicesAtPair, setDevicesAtPair] = useState(0);
  useEffect(() => {
    if (pair && deviceCount > devicesAtPair) setPair(null);
  }, [deviceCount]);

  if (!status) return <span className="text-[11.5px] text-fg-subtle">Loading…</span>;
  if (!status.enabled) {
    return (
      <p className="text-[12px] text-fg-subtle">
        Off. Turn it on, scan a QR code with your phone, and you can follow agents, answer them and launch new ones from the couch.
      </p>
    );
  }

  const showQr = async () => {
    setPairing(true);
    try {
      setDevicesAtPair(deviceCount);
      setPair(await phoneAccessApi.pair());
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setPairing(false);
    }
  };
  const remove = (id: string, name: string) =>
    useBoard.getState().askConfirm({
      title: `Remove ${name}?`,
      message: 'It loses access right away. You can pair it again with a new QR code.',
      confirmLabel: 'Remove phone',
      danger: true,
      onConfirm: () =>
        phoneAccessApi
          .removeDevice(id)
          .then((s) => usePhoneAccess.getState().receive(s))
          .catch((e: Error) => toast(`Could not remove it: ${e.message}`)),
    });

  return (
    <div className="space-y-3" data-testid="phone-access">
      {status.error ? (
        <p className="flex gap-2 text-[12px] text-error">
          <TriangleAlert size={14} className="shrink-0" /> {status.error}
        </p>
      ) : (
        <p className="text-[12px] text-fg-muted">
          Listening on {status.addresses.length ? status.addresses.map((ip) => `${ip}:${status.port}`).join(', ') : `port ${status.port}`}.
          Only phones you pair can connect. If your computer asks, allow GridHive on <b>private</b> networks.
        </p>
      )}
      <p className="flex gap-2 rounded-lg border border-needs/40 bg-needs/10 px-3 py-2 text-[12px] text-fg">
        <TriangleAlert size={14} className="mt-0.5 shrink-0 text-needs" />
        Use this on your home or office Wi-Fi only: traffic on the network is not encrypted yet. Away from home, use ntfy alerts
        below, or a VPN such as Tailscale.
      </p>

      {pair ? (
        <div className="flex flex-wrap items-start gap-4 rounded-xl border border-line bg-surface p-3" data-testid="phone-pair">
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pair.qrSvg)}`}
            alt="Pairing QR code"
            data-testid="phone-qr"
            className="size-44 shrink-0 rounded-lg bg-white p-2"
          />
          <div className="min-w-0 flex-1 space-y-2 text-[12.5px]">
            <p className="font-semibold text-fg">Scan with your phone's camera</p>
            <p className="text-fg-muted">Your phone must be on the same Wi-Fi. The code works once and expires in {Math.max(0, Math.ceil((pair.expiresAt - now) / 60_000))} min.</p>
            <p className="break-all font-mono text-[11px] text-fg-subtle" data-testid="phone-pair-url">
              {pair.url}
            </p>
            <button type="button" onClick={() => setPair(null)} className="text-[12px] text-fg-muted underline">
              Hide
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="phone-pair-start"
          disabled={pairing || !status.listening}
          onClick={() => void showQr()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] font-medium text-fg disabled:opacity-50
                     hover:border-accent/60 hover:text-accent"
        >
          {pairing ? <LoaderCircle size={13} className="animate-spin" /> : <QrCode size={13} />}
          Pair a phone
        </button>
      )}

      {status.devices.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line" data-testid="phone-devices">
          {status.devices.map((d) => (
            <li key={d.id} className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
              <Smartphone size={14} className="text-fg-muted" />
              <span className="font-medium text-fg">{d.name}</span>
              <span className={d.online ? 'text-resting' : 'text-fg-subtle'}>
                {d.online ? 'connected' : `seen ${formatSince(d.lastSeenAt, now)} ago`}
              </span>
              <button
                type="button"
                aria-label={`Remove ${d.name}`}
                onClick={() => remove(d.id, d.name)}
                className="ml-auto grid size-6 place-items-center rounded-md text-fg-subtle hover:bg-hover hover:text-error"
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
