import https from "https";
import fs from "fs";
import { exec } from "child_process";
class App {
    pb;
    username;
    password;
    constructor(pbase) {
        this.pb = pbase;
        this.username = this.extractStringEnvVar("POCKETBASE_USERNAME");
        this.password = this.extractStringEnvVar("POCKETBASE_PASSWORD");
    }
    async authorize() {
        const userData = await this.pb.collection("users").authWithPassword(this.username, this.password);
        console.log(userData);
    }
    subscribe() {
        const func = (e) => { this.newJobHandler(e); };
        this.pb.collection('jobs').subscribe('*', func);
    }
    async newJobHandler(data) {
        console.log(data.record);
        // get printer
        const printer_data = await this.pb.collection("printers").getOne(data.record.printer);
        console.log(printer_data);
        // get file
        const file_url = this.pb.getFileUrl(data.record, data.record.input);
        console.log(file_url);
        const local_path = "stls/" + data.record.id + ".stl";
        const file = fs.createWriteStream(local_path);
        console.log("downloading");
        const request = https.get(file_url, function (response) {
            response.pipe(file);
            // after download completed close filestream
            file.on("finish", () => {
                file.close();
                console.log("Download Completed");
            });
        });
        console.log("done");
        // start chop engine
        const cmd = `/home/greg/code/choppy/.venv/bin/choppy ${local_path} ${printer_data.size_x} ${printer_data.size_y} ${printer_data.size_z}`;
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.log(`error: ${error.message}`);
                return;
            }
            if (stderr) {
                console.log(`stderr: ${stderr}`);
                return;
            }
            console.log(`stdout: ${stdout}`);
        });
        // update status
        const db_update = await this.pb.collection("jobs").update(data.record.id, { "status": "processing" });
        console.log(db_update);
    }
    extractStringEnvVar(key) {
        const value = process.env[key];
        if (value === undefined) {
            const message = `The environment variable "${key}" cannot be "undefined".`;
            throw new Error(message);
        }
        return value;
    }
    cleanup(code) {
        console.log("cleaning up ${code}");
        this.pb.collection('jobs').unsubscribe('*');
        this.pb.authStore.clear();
    }
}
export default App;
