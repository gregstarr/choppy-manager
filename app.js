import { mkdirSync, createWriteStream } from "fs";
import { watch, open, readFile } from "fs/promises";
import { spawn } from "child_process";
import fetch from 'node-fetch';
import { pipeline } from 'stream/promises';
import tar from "tar";
import glob from "glob";
async function delay(ms) {
    const prom = new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
    return prom;
}
const tree_prog_re = new RegExp(/\$TREE_PROGRESS (.+)/g);
const connector_prog_re = new RegExp(/\$CONNECTOR_PROGRESS (.+)/g);
class JobHandler {
    pb;
    cmd = "/home/greg/code/choppy/.venv/bin/choppy";
    job_dir = "";
    proc = null;
    log_handle = null;
    tree_prog = 0;
    conn_prog = 0;
    job_id = null;
    finished = false;
    constructor(pbase) {
        this.pb = pbase;
    }
    async update_status() {
        if (this.log_handle == null)
            throw "log file not opened";
        if (this.job_id == null)
            throw "no job id";
        // check logs, update database
        const { bytesRead, buffer } = await this.log_handle.read();
        if (bytesRead == 0) {
            return;
        }
        const log_str = buffer.toString().trimEnd();
        for (let match of log_str.matchAll(tree_prog_re)) {
            this.tree_prog = Number(match[1]) * 100;
        }
        for (let match of log_str.matchAll(connector_prog_re)) {
            this.conn_prog = Number(match[1]) * 100;
        }
        // example update data
        const data = {
            "progress_tree": this.tree_prog,
            "progress_connector": this.conn_prog,
        };
        const record = await this.pb.collection("jobs").update(this.job_id, data);
        console.log({ "record": record });
    }
    async send_file() {
        if (this.job_id == null)
            throw "no job??";
        let files = glob.sync(`${this.job_dir}/chop*.stl`);
        const tfile = `${this.job_dir}/output.tar`;
        console.log({ "files": files });
        await tar.create({ file: tfile }, files);
        const formData = new FormData();
        const tar_data = await readFile(tfile);
        const tar_blob = new globalThis.Blob([new Uint8Array(tar_data)]);
        formData.append('output', tar_blob, "output.tar");
        return formData;
    }
    async finish_job(code) {
        if (this.job_id == null)
            throw "no job??";
        let ss;
        let form_data;
        if (code == 0) {
            form_data = await this.send_file();
            form_data.append("status", "finished");
        }
        else {
            form_data = new FormData();
            form_data.append("status", "error");
        }
        const record = await this.pb.collection("jobs").update(this.job_id, form_data);
        console.log({ "record": record, "code": code });
    }
    async new_job(data) {
        // get file info
        const file_url = this.pb.getFileUrl(data.record, data.record.input);
        const local_dir = `work/${data.record.id}`;
        this.job_dir = local_dir;
        this.job_id = data.record.id;
        mkdirSync(local_dir);
        const local_path = `${local_dir}/input.stl`;
        console.log({ data: data.record, file: file_url, local_path: local_path });
        // get printer
        const printer_data_p = this.pb.collection("printers").getOne(data.record.printer);
        // download file
        const response_p = fetch(file_url);
        const writefile_p = response_p.then(async (response) => {
            console.log({ "fetch": response });
            if (response.body == null)
                throw "no reponse body";
            await pipeline(response.body, createWriteStream(local_path));
        });
        // start chop engine
        const [, printer_data] = await Promise.all([writefile_p, printer_data_p]);
        console.log({ "printer_data": printer_data });
        const { size_x, size_y, size_z } = printer_data;
        const args = [local_path, size_x, size_y, size_z, "-o", local_dir];
        this.proc = spawn(this.cmd, args);
        this.proc.on("close", async (code) => { this.finish_job(code); });
        // update status
        const resp = await this.pb.collection("jobs").update(data.record.id, { "status": "processing" });
        console.log({ "update": resp });
        // wait for log
        const watcher = watch(this.job_dir);
        for await (const event of watcher) {
            if (event.filename == "info.log")
                break;
        }
        // open stream
        this.log_handle = await open(`${this.job_dir}/info.log`);
    }
}
class App {
    pb;
    username;
    password;
    jobs = [];
    constructor(pbase) {
        this.pb = pbase;
        this.username = this.extractStringEnvVar("POCKETBASE_USERNAME");
        this.password = this.extractStringEnvVar("POCKETBASE_PASSWORD");
    }
    async run() {
        await this.authorize().catch((e) => { console.log(e); });
        await this.subscribe().catch((e) => { console.log(e); });
        while (true) {
            let proms = [];
            let active_jobs = [];
            for (let job of this.jobs) {
                if (job.proc == null)
                    continue;
                if (job.proc.exitCode == null) {
                    proms.push(job.update_status().catch((e) => { console.log(e); }));
                    active_jobs.push(job);
                }
            }
            this.jobs = active_jobs;
            await Promise.all(proms);
            await delay(2000);
        }
    }
    async authorize() {
        return this.pb.collection("users").authWithPassword(this.username, this.password).then((user_data) => {
            console.log({ "user_data": user_data });
        });
    }
    async subscribe() {
        const func = async (r) => {
            const job_handler = new JobHandler(this.pb);
            await job_handler.new_job(r).catch((e) => { console.log(e); });
            this.jobs.push(job_handler);
        };
        const sub_resp = await this.pb.collection('jobs').subscribe('*', func);
        console.log({ "sub_resp": sub_resp });
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
        console.log(`cleaning up ${code}`);
        this.pb.collection('jobs').unsubscribe('*');
        this.pb.authStore.clear();
    }
}
export default App;
