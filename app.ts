import PocketBase from 'npm:pocketbase';
import { Record, RecordSubscription } from 'npm:pocketbase';
import "https://deno.land/std@0.174.0/dotenv/load.ts";
import { expandGlob } from "https://deno.land/std@0.174.0/fs/mod.ts";
import { Tar } from "https://deno.land/std@0.174.0/archive/tar.ts";
import { copy } from "https://deno.land/std@0.174.0/streams/copy.ts";
import { Buffer } from "https://deno.land/std@0.174.0/io/buffer.ts";
import { basename, join } from "https://deno.land/std@0.174.0/path/posix.ts";
import { assert } from "https://deno.land/std@0.174.0/testing/asserts.ts";


const choppy_cmd = Deno.env.get("CHOPPY_PATH");
assert(choppy_cmd)
const manager_dir = Deno.env.get("MANAGER_DIR");
assert(manager_dir)
const username = Deno.env.get("POCKETBASE_USERNAME");
assert(username)
const password = Deno.env.get("POCKETBASE_PASSWORD");
assert(password)
const blender_path = Deno.env.get("BLENDER_PATH");
assert(blender_path)
let path = Deno.env.get("PATH");
path = `${blender_path}:${path}`
Deno.env.set("PATH", path)


async function delay(ms: number) {
    const prom = new Promise((resolve) => {
        setTimeout(resolve, ms);
    })
    return await prom;
}

const tree_prog_re = new RegExp(/\$TREE_PROGRESS (.+)/g)
const connector_prog_re = new RegExp(/\$CONNECTOR_PROGRESS (.+)/g)


class JobHandler {
    pb: PocketBase
    job_dir = ""
    log_handle?: Deno.FsFile
    tree_prog = 0
    conn_prog = 0
    job_id: string | null = null
    finished = false
    proc?: Deno.Process

    constructor (pbase: PocketBase){
        this.pb = pbase;
    }

    async update_status() {
        if (this.log_handle == null) throw "log file not opened"
        if (this.job_id == null) throw "no job id"
        // check logs, update database
        const buffer = new Uint8Array(10000);
        const bytes_read = await this.log_handle.read(buffer)
        if (bytes_read == 0) return

        const log_str = new TextDecoder().decode(buffer).trimEnd();
        for (const match of log_str.matchAll(tree_prog_re)){
            this.tree_prog = Number(match[1]) * 100
        }
        for (const match of log_str.matchAll(connector_prog_re)){
            this.conn_prog = Number(match[1]) * 100
        }
        // example update data
        const data = {
            "progress_tree": this.tree_prog,
            "progress_connector": this.conn_prog,
        };

        const record = await this.pb.collection("jobs").update(this.job_id, data);
        console.log({"record": record})
    }

    async send_file() {
        if (this.job_id == null) throw "no job??"
        const tar = new Tar()
        for await (const file of expandGlob(join(this.job_dir, "chop*.stl"))) {
            console.log({"files": file})
            const stl = await Deno.readFile(file.path)
            await tar.append(basename(file.path), {
                reader: new Buffer(stl),
                contentSize: stl.byteLength
            });
        }
        const tfile = join(this.job_dir, "output.tar")
        const writer = await Deno.open(tfile, { write: true, create: true });
        await copy(tar.getReader(), writer);
        writer.close();
        const formData = new FormData();
        await Deno.readFile(tfile).then( (data) => {
            formData.append("output", new Blob([data]), "output.tar");
        })
        return formData
    }

    async finish_job(status: Deno.ProcessStatus) {
        if (this.job_id == null) throw "no job??"
        let form_data: FormData
        if (status.success) {
            form_data = await this.send_file()
            form_data.append("status", "finished")
        } else {
            form_data = new FormData();
            form_data.append("status", "failed")
        }
        
        const record = await this.pb.collection("jobs").update(this.job_id, form_data);
        console.log({"record": record, "code": status.code})
        this.finished = true;
    }

    async new_job(data: RecordSubscription<Record>) {
        // get file info
        const file_url = this.pb.getFileUrl(data.record, data.record.input);
        this.job_dir = join(manager_dir as string, "work", data.record.id);
        this.job_id = data.record.id
        await Deno.mkdir(this.job_dir)
        const local_path = join(this.job_dir, "input.stl");
        console.log({data: data.record, file: file_url, local_path: local_path});

        // get printer
        const printer_data_p = this.pb.collection("printers").getOne(data.record.printer);
        // download file
        const response_p = fetch(file_url)
        const writefile_p = response_p.then(async (response) => {
            console.log({"fetch": response})
            if (response.body == null)  throw "no reponse body";
            await Deno.writeFile(local_path, response.body)
        })

        // start chop engine
        const [, printer_data] = await Promise.all([writefile_p, printer_data_p])
        console.log({"printer_data": printer_data})
        const {size_x, size_y, size_z} = printer_data;
        const cmd = [choppy_cmd, local_path, size_x, size_y, size_z, "-o", this.job_dir];
        this.proc = Deno.run({"cmd": cmd, "stdout": "null"});

        // update status
        const resp = await this.pb.collection("jobs").update(data.record.id, {"status": "processing"});
        console.log({"update": resp})

        // wait for log
        const watcher = Deno.watchFs(this.job_dir)
        for await (const event of watcher) {
            console.log(event)
            if (event.paths.map(x => basename(x)).includes("info.log")) break
        }
        // open stream
        this.log_handle = await Deno.open(join(this.job_dir, "info.log"))
    }

    async run(){
        if (this.proc === undefined) throw "no process yet"
        await this.proc.status().then((status) => {this.finish_job(status)})
    }
}


class App {
    pb: PocketBase;
    jobs: Array<JobHandler> = []

    constructor (pbase: PocketBase) {
        this.pb = pbase;
        console.log({username, password})
    }

    async run() {
        await this.authorize().catch((e) => {console.log(e)})
        await this.subscribe().catch((e) => {console.log(e)})
        while (true) {
            const proms = [];
            let i = this.jobs.length
            while (i--) {
                const job = this.jobs[i]
                if (job.finished) { 
                    this.jobs.splice(i, 1);
                } else {
                    console.log("update")
                    proms.push(job.update_status().catch((e) => {console.log(e)}))
                }
            }
            await Promise.all(proms)
            await delay(2000)
        }
    }

    async authorize() {
        const user_data = await this.pb.collection("users").authWithPassword(username as string, password as string);
        console.log({ "user_data": user_data });
        return user_data
    }

    async subscribe() {
        const func = async (r: RecordSubscription) => {
            const job_handler = new JobHandler(this.pb);
            const new_job_prom = job_handler.new_job(r)
                .then(() => {
                    this.jobs.push(job_handler)
                }).then( async () => {
                    await job_handler.run()
                })
            await new_job_prom.catch((e) => {console.log(e)})
        };
        const sub_resp = await this.pb.collection('jobs').subscribe('*', func)
        console.log({"sub_resp": sub_resp});
        return sub_resp
    }

    cleanup(code: number) {
        console.log(`cleaning up ${code}`)
        this.pb.collection('jobs').unsubscribe('*');
        this.pb.authStore.clear();
    }
}

export default App
