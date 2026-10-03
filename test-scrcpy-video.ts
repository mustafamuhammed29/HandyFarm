import fs from 'fs';
import { Adb as YumeAdb, AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy';
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

  const serverBuffer = fs.readFileSync('scrcpy-server-v2.4.jar');
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

  const { AdbScrcpyOptions2_4 } = await import('@yume-chan/adb-scrcpy');
  const scrcpyOptions = new AdbScrcpyOptions2_4({
    maxSize: 800,
    maxFps: 30,
    videoBitRate: 2000000,
    tunnelForward: true,
    control: true,
    sendDeviceMeta: false,
    sendDummyByte: false
  }, { version: '2.4' });

  try {
    const activeScrcpyClient = await AdbScrcpyClient.start(
      yumeAdb,
      '/data/local/tmp/scrcpy-server.jar',
      scrcpyOptions
    );
    console.log("Started successfully");
    const videoStreamInstance = await activeScrcpyClient.videoStream;
    console.log("Metadata:", videoStreamInstance.metadata);
    const reader = videoStreamInstance.stream.getReader();
    for (let i = 0; i < 5; i++) {
        const packet = await reader.read();
        if (packet.done) break;
        console.log(`Packet ${i}: type=${packet.value.type}, keyframe=${packet.value.keyframe}, size=${packet.value.data.byteLength}`);
    }
    process.exit(0);
  } catch (e: any) {
    console.error("Exited with error:", e);
    process.exit(1);
  }
}
test();
