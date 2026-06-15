import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { PAIR_BRIDGE_URL } from '../config/hetzner';

export type PairTokens = {
  refresh_token: string;
  bridge_id: string;
  org_id: string;
  lan_api_key: string;
};

export function openPairInstallerSignIn(
  code: string,
  label: string,
): Promise<void> {
  // Param is "claim_code" not "code" — the operator-portal magic-link return URL
  // already carries GoTrue's PKCE ?code=, which would collide.
  const url = `${PAIR_BRIDGE_URL}/?claim_code=${encodeURIComponent(code)}&label=${encodeURIComponent(label)}`;
  return openUrl(url);
}

export function listenForPairTokens(
  handler: (tokens: PairTokens) => void,
): Promise<UnlistenFn> {
  return listen<PairTokens>('pair-tokens-received', (event) => {
    handler(event.payload);
  });
}

export type WslStatus = {
  installed: boolean;
  defaultDistro: string | null;
  distros: string[];
};

export type CommandResult = { exitCode: number };

export type WslOutputEvent = {
  stream: 'stdout' | 'stderr';
  line: string;
};

export function detectWsl(): Promise<WslStatus> {
  return invoke<WslStatus>('detect_wsl');
}

export function installWsl(): Promise<null> {
  return invoke<null>('install_wsl');
}

export function detectUbuntu(): Promise<string | null> {
  return invoke<string | null>('detect_ubuntu');
}

export type GitConfig = {
  name: string | null;
  email: string | null;
};

export function readGitConfig(): Promise<GitConfig> {
  return invoke<GitConfig>('read_git_config');
}

export function installUbuntu(): Promise<null> {
  return invoke<null>('install_ubuntu');
}

export function runInWsl(
  distro: string,
  command: string,
  eventId: string,
): Promise<CommandResult> {
  return invoke<CommandResult>('run_in_wsl', { distro, command, eventId });
}

export function aptInstallDeps(
  distro: string,
  eventId: string,
): Promise<CommandResult> {
  return invoke<CommandResult>('apt_install_deps', { distro, eventId });
}

export function installNode22(
  distro: string,
  eventId: string,
): Promise<CommandResult> {
  return invoke<CommandResult>('install_node22', { distro, eventId });
}

export function installClaudeCli(
  distro: string,
  eventId: string,
): Promise<CommandResult> {
  return invoke<CommandResult>('install_claude_cli', { distro, eventId });
}

export function configureGit(
  distro: string,
  name: string,
  email: string,
  eventId: string,
): Promise<CommandResult> {
  return invoke<CommandResult>('configure_git', {
    distro,
    name,
    email,
    eventId,
  });
}

export function downloadBridge(
  distro: string,
  eventId: string,
): Promise<CommandResult> {
  return invoke<CommandResult>('download_bridge', { distro, eventId });
}

export function npmInstallBridge(
  distro: string,
  eventId: string,
): Promise<CommandResult> {
  return invoke<CommandResult>('npm_install_bridge', { distro, eventId });
}

export function npmRunBuildBridge(
  distro: string,
  eventId: string,
): Promise<CommandResult> {
  return invoke<CommandResult>('npm_run_build_bridge', { distro, eventId });
}

export function generateApiKey(): Promise<string> {
  return invoke<string>('generate_api_key');
}

export function writeEnvFile(
  distro: string,
  apiKey: string,
  claudeHome: string,
): Promise<null> {
  return invoke<null>('write_env_file', { distro, apiKey, claudeHome });
}

export function openClaudeOauth(): Promise<null> {
  return invoke<null>('open_claude_oauth');
}

export function pollClaudeCreds(distro: string): Promise<boolean> {
  return invoke<boolean>('poll_claude_creds', { distro });
}

export function openOperatorPortal(): Promise<null> {
  return invoke<null>('open_operator_portal');
}

export function waitForClaimCode(distro: string): Promise<string> {
  return invoke<string>('wait_for_claim_code', { distro });
}

export function getMachineLabel(): Promise<string> {
  return invoke<string>('get_machine_label');
}

export function writePairEnv(
  distro: string,
  refreshToken: string,
  bridgeId: string,
  orgId: string,
  lanApiKey: string,
): Promise<void> {
  return invoke<void>('write_pair_env', {
    distro,
    refreshToken,
    bridgeId,
    orgId,
    lanApiKey,
  });
}

export function restartBridgeService(distro: string): Promise<void> {
  return invoke<void>('restart_bridge_service', { distro });
}

export function installSystemdService(
  distro: string,
  eventId: string,
): Promise<CommandResult> {
  return invoke<CommandResult>('install_systemd_service', { distro, eventId });
}

export function listenWslOutput(
  eventId: string,
  onLine: (event: WslOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<WslOutputEvent>(`wsl-output-${eventId}`, (event) => {
    onLine(event.payload);
  });
}
