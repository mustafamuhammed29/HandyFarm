import { vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

const tmpDir = path.join(os.tmpdir(), 'handyfarm-test');

vi.mock('electron', () => {
  return {
    app: {
      getPath: (name: string) => path.join(tmpDir, name),
      isPackaged: false,
      getAppPath: () => process.cwd(),
      whenReady: () => Promise.resolve(),
      on: () => {},
    },
    BrowserWindow: class {
      webContents = { send: () => {} };
      isDestroyed() { return false; }
    },
    ipcMain: {
      handle: () => {},
      on: () => {},
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
    },
    dialog: {},
    clipboard: {
      readText: () => '',
      writeText: () => {},
    },
    nativeImage: {
      createFromBuffer: () => ({
        getSize: () => ({ width: 0, height: 0 }),
        resize: () => ({ toJPEG: () => Buffer.from([]) }),
      }),
    },
  };
});
