import { Adb, AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { AdbScrcpyClient, AdbScrcpyOptions1_21 } from '@yume-chan/adb-scrcpy';
import { ScrcpyOptions1_21, ScrcpyVideoStreamPacket } from '@yume-chan/scrcpy';
import fs from 'fs';

async function main() {
    const connector = new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 });
    const client = new AdbServerClient(connector);
    
    // Connect to specific device
    const transport = await client.createTransport({ serial: '106293738O006649' });
    const adb = new Adb(transport);

    console.log("Connected to ADB:", await adb.getProp('ro.product.model'));

    // Read the server binary
    const serverBuffer = fs.readFileSync('C:\\scrcpy\\scrcpy-server');
    
    console.log("Starting AdbScrcpyClient...");
    const scrcpyClient = await AdbScrcpyClient.start(
        adb,
        '/data/local/tmp/scrcpy-server.jar',
        '2.1', // scrcpy version 2.1 
        new AdbScrcpyOptions1_21(new ScrcpyOptions1_21({ maxFps: 30, maxSize: 800 })),
        serverBuffer
    );
    
    console.log("AdbScrcpyClient started! Device name:", scrcpyClient.deviceName);

    // Read video stream
    const reader = scrcpyClient.videoStream.getReader();
    console.log("Waiting for video stream data...");
    
    for (let i = 0; i < 5; i++) {
        const { value, done } = await reader.read();
        if (done) {
            console.log("Video stream ended.");
            break;
        }
        console.log(`Received video packet of type ${value?.type}, length ${value?.data?.byteLength}`);
    }

    scrcpyClient.close();
    adb.close();
}

main().catch(console.error);
