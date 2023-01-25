import PocketBase  from "pocketbase";
import App from "./app.js";
import eventsource from 'eventsource';

globalThis.EventSource = eventsource;


const pb = new PocketBase('https://choppy.pro:443');

const app = new App(pb);
await app.authorize();
console.log("ASDASD")
app.subscribe();

// console.log("register exit")
// process.on("exit", app.cleanup);
