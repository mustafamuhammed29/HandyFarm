/**
 * HandyFarm Text Input Handler & Routing
 *
 * Android platform limitation:
 * `adb shell input text` internally relies on KeyCharacterMap.getEvents(),
 * which returns null for non-ASCII characters (e.g. Arabic, CJK, accented Latin, emojis),
 * throwing a java.lang.NullPointerException in InputShellCommand.sendText.
 *
 * For pure-ASCII strings:
 * Routes directly through `adb shell input text` using base64 decoding (fast, no clipboard round-trip).
 *
 * For non-ASCII strings:
 * Routes through the companion app (com.handyfarm.clipper):
 * 1. Base64-encodes the text and broadcasts `clipper.set` to set device clipboard.
 * 2. Retains input field focus (BroadcastReceiver does not steal window focus).
 * 3. Dispatches `adb shell input keyevent 279` (KEYCODE_PASTE) into the focused field.
 */

export type TextRoutingMode = 'ascii_direct' | 'clipboard_paste';

export const CLIPPER_DEFAULT_RECEIVER = 'com.handyfarm.clipper/.ClipperReceiver';
export const KEYCODE_PASTE = '279';

/**
 * Returns true if the string is empty or contains exclusively ASCII characters (code points 0x00 to 0x7F).
 */
export function isAsciiOnly(text: string): boolean {
  if (!text) return true;
  return /^[\x00-\x7F]*$/.test(text);
}

/**
 * Determines whether text should be routed via fast direct input or clipboard paste.
 */
export function determineTextRoute(text: string): TextRoutingMode {
  return isAsciiOnly(text) ? 'ascii_direct' : 'clipboard_paste';
}

export interface AsciiInputCommand {
  b64: string;
  shellCommand: string;
}

export function buildAsciiInputCommand(text: string): AsciiInputCommand {
  const b64 = Buffer.from(text || '', 'utf-8').toString('base64');
  return {
    b64,
    shellCommand: `RAW=$(echo ${b64} | base64 -d); input text "$RAW"`
  };
}

export interface ClipboardPasteCommand {
  b64: string;
  broadcastCommand: string;
  pasteCommand: string;
  combinedCommand: string;
}

export function buildClipboardPasteCommand(
  text: string,
  receiver: string = CLIPPER_DEFAULT_RECEIVER
): ClipboardPasteCommand {
  const b64 = Buffer.from(text || '', 'utf-8').toString('base64');
  const broadcastCommand = `RAW=$(echo ${b64} | base64 -d); am broadcast -a clipper.set -n ${receiver} --es text "$RAW"`;
  const pasteCommand = `input keyevent ${KEYCODE_PASTE}`;
  const combinedCommand = `${broadcastCommand} && ${pasteCommand}`;
  return {
    b64,
    broadcastCommand,
    pasteCommand,
    combinedCommand
  };
}

export interface SendTextDependencies {
  deviceId: string;
  text: string;
  ensureClipperInstalled: (deviceId: string) => Promise<void>;
  execShell: (deviceId: string, command: string) => Promise<string | void>;
  logAction?: (deviceId: string, action: string) => void;
  clipperReceiver?: string;
}

export interface SendTextResult {
  success: boolean;
  route: TextRoutingMode;
  error?: string;
}

/**
 * Orchestrates sending text to an Android device, automatically routing non-ASCII text
 * through Clipper's clipboard and dispatching KEYCODE_PASTE (279).
 */
export async function sendTextToDevice(deps: SendTextDependencies): Promise<SendTextResult> {
  const {
    deviceId,
    text,
    ensureClipperInstalled,
    execShell,
    logAction,
    clipperReceiver = CLIPPER_DEFAULT_RECEIVER
  } = deps;

  const route = determineTextRoute(text);
  try {
    if (route === 'ascii_direct') {
      const { shellCommand } = buildAsciiInputCommand(text);
      await execShell(deviceId, shellCommand);
      logAction?.(deviceId, `Sent text: ${text}`);
      return { success: true, route };
    } else {
      // 1. Ensure companion app is installed
      await ensureClipperInstalled(deviceId);
      // 2. Base64-encode and broadcast to set device clipboard
      const { broadcastCommand, pasteCommand } = buildClipboardPasteCommand(text, clipperReceiver);
      await execShell(deviceId, broadcastCommand);
      // 3. Dispatch KEYCODE_PASTE (279) into the focused field
      await execShell(deviceId, pasteCommand);
      logAction?.(deviceId, `Sent non-ASCII text via clipboard paste: ${text}`);
      return { success: true, route };
    }
  } catch (err: any) {
    return {
      success: false,
      route,
      error: err?.message || String(err)
    };
  }
}
