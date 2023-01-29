import PocketBase  from "npm:pocketbase";
import App from "./app.ts";
import eventsource from 'npm:eventsource';

globalThis.EventSource = eventsource;


const pb = new PocketBase('https://choppy.pro:443');

const app = new App(pb);
await app.run();
console.log("register exit")
process.on("exit", app.cleanup);
