import type { CloudStatus } from '../../shared/protocol';
import { cloudApi, useCloud } from '../lib/cloud';
import { useBoard } from '../lib/store';
import { GitHubMark, GoogleMark } from './provider-marks';

// "Continue with GitHub / Google" in each provider's own button style (GitHub: dark with the
// Octocat mark; Google: white with the four-color G). The browser opens that provider's sign-in,
// which returns to gridhive.dev/link with this computer's code.

async function signIn(provider: 'github' | 'google'): Promise<void> {
  try {
    useCloud.getState().receive((await cloudApi.link(provider)) as CloudStatus);
  } catch (e) {
    useBoard.getState().toast(`Sign-in failed: ${(e as Error).message}`);
  }
}

export function SignInButtons({ compact = false }: { compact?: boolean }) {
  const size = compact ? 'h-8 text-[12.5px] px-3' : 'h-10 text-[14px] px-4';
  return (
    <div className={compact ? 'flex flex-wrap gap-2' : 'grid gap-2'} data-testid="signin-buttons">
      <button
        type="button"
        data-testid="cloud-signin"
        data-provider="github"
        onClick={() => void signIn('github')}
        className={`inline-flex items-center justify-center gap-2 rounded-lg bg-[#24292f] font-semibold text-white ring-1 ring-white/10 hover:bg-[#32383f] ${size}`}
      >
        <GitHubMark /> Continue with GitHub
      </button>
      <button
        type="button"
        data-testid="cloud-signin-google"
        data-provider="google"
        onClick={() => void signIn('google')}
        className={`inline-flex items-center justify-center gap-2 rounded-lg border border-[#dadce0] bg-white font-medium text-[#1f1f1f] hover:bg-[#f8f9fa] ${size}`}
      >
        <GoogleMark /> Continue with Google
      </button>
    </div>
  );
}
