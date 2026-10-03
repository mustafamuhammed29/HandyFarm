import fs from 'fs';
import { Adb as YumeAdb, AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { AdbScrcpyClient, AdbScrcpyOptions2_4, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy';
import { ReadableStream } from 'stream/web';

async function test() {
  const connector = new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 });
  const client = new AdbServerClient(connector);
  const devices = await client.getDevices();
  const device = devices.find(d => d.state === 'device');
  if (!device) {
    console.error("No device found");
    return;
  }
  const transport = await client.createTransport({ serial: device.serial });
  const yumeAdb = new YumeAdb(transport);

  const serverBuffer = fs.readFileSync('C:\\scrcpy\\scrcpy-server');
  await AdbScrcpyClient.pushServer(
    yumeAdb,
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(serverBuffer));
        controller.close();
      }
    }),
    '/data/local/tmp/scrcpy-server.jar'
  );

  const scrcpyOptions = new AdbScrcpyOptionsLatest({
    maxSize: 800,
    maxFps: 30,
    videoBitRate: 2000000,
    tunnelForward: true,
    control: true,
    sendDeviceMeta: false,
    sendDummyByte: false
  }, { version: '4.1' }); 

  try {
    const activeScrcpyClient = await AdbScrcpyClient.start(
      yumeAdb,
      '/data/local/tmp/scrcpy-server.jar',
      scrcpyOptions
    );
    console.log("Started successfully");
    const stream = await activeScrcpyClient.videoStream;
    const reader = stream!.getReader();
    const packet = await reader.read();
    console.log("First packet:", packet.done ? "Done" : packet.value.data.byteLength + " bytes");
    process.exit(0);
  } catch (e: any) {
    console.error("Exited with error:", e);
    process.exit(1);
  }
}
test();
