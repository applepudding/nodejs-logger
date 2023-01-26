/* 
Partial code to read modbus rtu devices
 */

class mbrtu {
    constructor() {
        this.current = null;
        this.sim = { value: "0" };
        this.conn = null;
    }

    async init(simulation, conn) {
        if (simulation) {
            console.log("init sim");
            this.current = this.sim;
        } else {
            const ModbusRTU = require("modbus-serial");
            this.current = new ModbusRTU();
            this.current.connectRTUBuffered(conn.conn, { baudRate: 9600 });
            this.current.setTimeout(500)
        }
        this.conn = conn;
        for (let dev of this.conn.device_list) {
            let tempLib = require("./mod_" + dev.mb_type);
            let tempList = new tempLib();
            dev.mb_list = tempList.mb_list;
            dev.calculateLogic = (tempList.calculateLogic) ? tempList.calculateLogic : null;
        }
    }

    async getValue(conn, clientName, db, devGlobalList, socketgui) {
        let simulation = conn.simulation;
        if (this.current) {
            for (let dev of this.conn.device_list) {

                let tempTableName = clientName + "." + this.conn.name + "." + dev.mb_type + "." + dev.mb_id;

                let tempTs = Math.floor(Date.now() / 1000);
                let tempTs_rounded = Math.floor(tempTs / 60) * 60;
                dev.ts = dev.ts ? dev.ts : tempTs_rounded;

                //if (!(tempTs_rounded % 2)) {
                //this.current.value = (tempTs_rounded % 120) ? 1 : 0;
                //}

                if (dev.ts < tempTs_rounded) { //if minute is changing
                    let totalErrors = this.calculateSum(dev.mb_list, "err");
                    let oee = 1 - (totalErrors / (this.calculateSum(dev.mb_list, "count") + totalErrors));
                    let tempJson = { oee: round3(oee) };
                    for (let mb of dev.mb_list) {
                        if (mb.preset) {
                            tempJson[mb.name] = mb.preset ? mb.preset : 0;
                        }
                        else {
                            tempJson[mb.name] = round3(mb.avg);
                        }
                        delete mb.avg;
                        delete mb.total;
                        delete mb.count;
                        delete mb.err;
                    }
                    console.log(tempJson);
                    db.insert(tempTableName, dev.ts, tempJson);

                    dev.ts = tempTs_rounded;
                }

                if (!simulation) await this.current.setID(dev.mb_id);


                //check global command list
                //console.log(devGlobalList.cmd);
                for (let [idx, cmd] of devGlobalList.cmd.entries()) {
                    if (cmd.ts + 10000 < Date.now()) {
                        console.log("Expired Command: " + JSON.stringify(cmd) + " REMOVED")
                        devGlobalList.cmd.splice(idx, 1);
                    } else {
                        if (cmd.dev == tempTableName) {
                            console.log("processing: " + tempTableName);
                            let tempCmd = cmd.data.split("=");
                            if (dev.logic.hasOwnProperty(tempCmd[0])) dev.logic[tempCmd[0]] = tempCmd[1];
                            devGlobalList.cmd.splice(idx, 1);
                        }
                    }
                }

                for (let mb of dev.mb_list) {
                    try {
                        mb.err = mb.err ? mb.err : 0;
                        let val = 0;
                        mb.count = mb.count ? mb.count + 1 : 1;
                        switch (mb.function) {
                            case 4:
                                val = simulation ? Math.floor(Math.random() * 1000) / 100 : await this.current.readInputRegisters(mb.address, 1);
                                mb.val = simulation ? val : val.data[0] / Math.pow(10, mb.tens);
                                if (mb.val == 3100) {
                                    mb.val = 0;
                                }
                                mb.total = mb.total ? mb.total + mb.val : mb.val;
                                mb.avg = mb.total / mb.count;
                                break;
                            case 5: //write bit
                                val = mb.preset ? mb.preset : 0;
                                if (simulation) {

                                    //console.log(this.current.value);
                                }
                                else {
                                    await this.current.writeCoil(mb.address, this.current.value);
                                }
                                mb.val = val;
                                break;
                            case 6: //write register
                                val = mb.preset ? mb.preset : 0;

                                if (dev.logic && dev.calculateLogic) {
                                    val = await dev.calculateLogic(dev.logic, devGlobalList);
                                }

                                if (simulation && val != null) {
                                    console.log("Simulating to val: " + val);
                                } else {
                                    if (mb.preset) {
                                        await this.current.writeRegister(mb.address, mb.preset);
                                    }
                                    else {
                                        if (val != null) {
                                            await this.current.writeRegister(mb.address, val);
                                        }
                                    }
                                }

                                mb.val = val;
                                break;
                        }
                        console.log(dev.mb_id + "." + mb.address + " - " + mb.name + ": " + mb.val);
                    } catch (e) {
                        mb.err = mb.err ? mb.err + 1 : 1; //count errors
                        mb.count = mb.count ? mb.count - 1 : 1;
                        //console.log(e)
                    }
                }

                ////// check globalList
                if (checkInGlobalList(devGlobalList, tempTableName)) {
                    updateGlobalList(devGlobalList, tempTableName, dev);
                } else {
                    addToGlobalList(devGlobalList, tempTableName);
                }
                //console.log(devGlobalList);

                //update websocket gui
                if (socketgui) socketgui.emit('senddata', dev.mb_list, tempTableName);
            }

        } else {
            await this.init(simulation, conn);
            //await this.getValue(conn, simulation);
        }

    }
    calculateSum(obj, field) {
        return obj.map(items => items[field]).reduce((prev, curr) => prev + curr, 0);
    }
};

module.exports = mbrtu;

function round3(val) {
    return Math.round(val * 1000) / 1000;
}

function checkInGlobalList(devGlobalList, devName) {
    for (let el of devGlobalList.dev) {
        if (el.name == devName) {
            return true;
        }
    }
    return false;
}
function addToGlobalList(devGlobalList, devName) {
    devGlobalList.dev.push({ name: devName });
}

function updateGlobalList(devGlobalList, devName, dev) {
    for (let el of devGlobalList.dev) {
        if (el.name == devName) {
            for (let mb of dev.mb_list) {
                el[mb.name] = mb.val;
            }
            break;
        }
    }
}