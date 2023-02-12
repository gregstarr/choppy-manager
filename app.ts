import PocketBase from 'npm:pocketbase';
import { Record, RecordSubscription } from 'npm:pocketbase';
import "https://deno.land/std@0.174.0/dotenv/load.ts";
import { Tar } from "https://deno.land/std@0.174.0/archive/tar.ts";
import { copy } from "https://deno.land/std@0.174.0/streams/copy.ts";
import { Buffer } from "https://deno.land/std@0.174.0/io/buffer.ts";
import { basename, join, extname } from "https://deno.land/std@0.174.0/path/posix.ts";
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
const file_re = new RegExp(/\$OUTPUT_FILE (.+)/g)
const nc_re = new RegExp(/\$N_CONNECTORS (.+)/g)


class JobHandler {
    pb: PocketBase
    job_dir = ""
    log_handle?: Deno.FsFile
    tree_prog = 0
    conn_prog = 0
    job_id: string | null = null
    finished = false
    success = false;
    test = true;
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
        console.log(log_str);
        
        for (const match of log_str.matchAll(tree_prog_re)){
            this.tree_prog = Number(match[1]) * 100
        }
        for (const match of log_str.matchAll(connector_prog_re)){
            this.conn_prog = Number(match[1]) * 100
        }
        const data = {
            "progress_tree": this.tree_prog,
            "progress_connector": this.conn_prog,
        };

        const record = await this.pb.collection("jobs").update(this.job_id, data);
        console.log({"record": record})
    }

    async send_file() {
        if (this.log_handle == null) throw "log file not opened"
        if (this.job_id == null) throw "no job??"
        const buffer = new Uint8Array(5000);
        await this.log_handle.seek(-5000, Deno.SeekMode.End)
        const bytes_read = await this.log_handle.read(buffer)
        if (bytes_read == 0) throw "wtf"

        const log_str = new TextDecoder().decode(buffer).trimEnd();
        const tar = new Tar()
        for (const match of log_str.matchAll(file_re)){
            const file = match[1];
            console.log({"files": file})
            const stl = await Deno.readFile(file)
            await tar.append(basename(file), {
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

        for (const match of log_str.matchAll(nc_re)){
            formData.append("n_connectors", match[1]);
            break;
        }

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
        form_data.append("progress_tree", "100")
        form_data.append("progress_connector", "100")

        const record = await this.pb.collection("jobs").update(this.job_id, form_data, {"$autoCancel": false});
        console.log({"record": record, "code": status.code})
        this.finished = true;
        this.success = status.code === 0;
    }

    async new_job(data: RecordSubscription<Record>) {
        // determine user type (test or not)
        const userrecord = await this.pb.collection('users').getOne(data.record.user);
        this.test = userrecord.role == "test"
        console.log({"user": userrecord, "test": this.test})

        // get file info
        const file_url = this.pb.getFileUrl(data.record, data.record.input);
        const file_ext = extname(data.record.input);
        this.job_dir = join(manager_dir as string, "work", data.record.id);
        this.job_id = data.record.id
        await Deno.mkdir(this.job_dir, {recursive: true})
        const local_path = join(this.job_dir, `input${file_ext}`);
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
        await this.proc.status()
            .then(async (status) => {
                await this.finish_job(status)
            }).catch(async (err) => {
                console.log(err)
                if( this.job_id ){
                    await this.pb.collection("jobs").update(this.job_id, {"status": "failed"});
                    await this.pb.collection("jobs").update(this.job_id, {"status": "failed"});
                }
            })
    }
}


class App {
    pb: PocketBase;
    jobs: Array<JobHandler> = []
    n_total = 0;
    n_success = 0;

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
                    if( !job.test ) {
                        this.n_total++;
                        this.n_success = job.success? this.n_success + 1: this.n_success;
                        await this.pb.collection('success_rate').update('hnjqu2jrruix7iy', {
                            "n_success": this.n_success,
                            "n_total": this.n_total
                        });
                    }
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
