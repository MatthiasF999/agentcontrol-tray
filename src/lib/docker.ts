import { invoke } from '@tauri-apps/api/core';

export interface DockerAvailability {
  installed: boolean;
  version: string | null;
  error: string | null;
}

export interface DockerRunResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

export async function checkDocker(): Promise<DockerAvailability> {
  return await invoke<DockerAvailability>('docker_available');
}

export async function composeRun(
  composeDir: string,
  args: string[],
): Promise<DockerRunResult> {
  return await invoke<DockerRunResult>('docker_compose', {
    composeDir,
    args,
  });
}
