import pkg from '@devicefarmer/adbkit';
const { Adb } = pkg;
const client = Adb.createClient();

async function run() {
    const stream = await client.shell('106293738O006649', 'am broadcast -a clipper.get');
    console.log("Got stream");
    const buffer = await Adb.util.readAll(stream);
    console.log("Output:", buffer.toString());
}

run().catch(console.error);
