'use strict';

const fs = require('fs');
const axios = require('axios').default;
const xmlParser = require('xml2json');
const io = require("socket.io-client");

//config load
let cfg = JSON.parse(fs.readFileSync('config.json'));
let slvList = cfg.client_list;

let idle_ms = cfg.main.idle_ms ? cfg.main.idle_ms : 1000;
let reconnect_delay = cfg.main.reconnection_delay_ms ? cfg.main.reconnection_delay_ms : 10000;
let holdData_delay = cfg.main.device_holdDataDelay_s ? cfg.main.device_holdDataDelay_s : 10;

let alertCfg_ms = cfg.main.alerts_email.config_delay_ms ? cfg.main.alerts_email.config_delay_ms : 900000;
let alertEnable = cfg.main.alerts_email.enable ? cfg.main.alerts_email.enable : false;

let socket = cfg.main.websocket.enable ? io(cfg.main.websocket.server) : null;

let initWebsocket = (function () {
    if (cfg.main.websocket.enable) {
        console.log("Websocket Init");
        socket.on('connect', () => {
            console.log('Websocket Successfully connected!');
            socket.emit('adduser', 'qclient-js');
            for (let slv of slvList) {
                socket.emit('joinMultiRoom', slv.alias);
            }
        });
    }
}());

let getSlaveUrl = function (type, address) {
    let url_header = "";
    let url_footer = "";
    switch (type) {
        case "xvj":
            url_header = "http://";
            url_footer = "/ajax/refresh.asp?mode=3&param=InternalPVS&force=false";
            break;
        case "xnj":
            url_header = "http://";
            url_footer = "/ajax/F_refresh.asp?Mode=RT";
        default:
            break;
    }
    return url_header + address + url_footer;
};

let checkOtherSlave = function () {
    for (let slv of slvList) {
        if (slv.address && slv.lastResponse) {
            let tempDelay = Date.now() - slv.lastResponse;
            let tempIpDelay = Date.now() - slv.lastIPUpdate;
            if ((tempDelay > reconnect_delay) && (tempIpDelay > reconnect_delay)) {
                console.log(slv.alias + " is " + tempDelay + " ms behind, refreshing IP on next opportunity");
                delete slv.address;

                /// restart script
                if (cfg.main.restart_on_fail) {
                    console.log("This is pid " + process.pid + " RESTARTING");
                    process.exit();
                }
                ////////////////////
            }
        }
    }
};

let apiSendEmail = function (inputDb, inputTs, inputSite, inputType, inputVal, inputLimit, inputEmails, inputDetails, inputNotes = null) {
    let uri = cfg.main.alerts_email.server + "alert-email-send.php";
    let params = {
        db: inputDb,
        ts: inputTs,
        site: inputSite,
        type: inputType,
        val: inputVal,
        limit: inputLimit,
        emails: inputEmails,
        details: inputDetails,
        notes: inputNotes
    };
    console.log("emails: ", inputEmails);
    axios.post(uri, params, { timeout: 5000 }).catch(function (error) { console.log("Email error"); });
};

let checkAlertCfg = function (slv) {
    if (alertEnable) {
        if ((Date.now() - slv.lastAlertCfg) > alertCfg_ms) {   //refresh the alert from server
            console.log(slv.alias + " fetching alert info from server");
            let uri = cfg.main.alerts_email.server + "alert-rules-get.php";
            let params = { db: slv.alias };

            axios.post(uri, params, { timeout: 5000 })
                .then(function (res) {
                    if (res.data.d) {
                        slv.alert = {
                            enable: parseInt(res.data.d.enabled),
                            notes: res.data.d.notes,
                            cd: parseInt(res.data.d.cds) * 1000,
                            emails: (res.data.d.emails) ? res.data.d.emails.split(";") : [],
                            names: (res.data.d.names) ? res.data.d.emails.split(";") : [],
                            levels: JSON.parse(res.data.d.alerts),
                            hours: JSON.parse(res.data.d.activeHours),
                            details: (res.data.d.details) ? res.data.d.details : "",
                            skip_email: res.data.d.skip_email ? JSON.parse(res.data.d.skip_email) : null
                        };
                        //console.log(slv.alert);
                    } else {
                        if (slv.alert) {
                            delete slv.alert;
                        }
                    }
                })
                .catch(function (error) {
                    console.log(slv.alias + " alert error: " + error.message);
                })
                .then(function () {
                    slv.lastAlertCfg = Date.now();
                });
        }
    }
};

let checkValueAlert = function (slv, inputValue) {
    if (alertEnable) {
        if (slv.alert) {
            if (slv.alert.enable) {
                let currentHour = (new Date()).getHours();
                let currentDay = (new Date()).getDay();
                let tempThreshold = slv.alert.levels[currentDay];
                let skipEmail = slv.alert.skip_email ? slv.alert.skip_email[currentDay] : null;
                //init alertTiming if length not equal
                if (slv.alertTiming.lastTriggered.length != tempThreshold.length) {
                    slv.alertTiming.lastTriggered = [];
                    for (let el of tempThreshold) {
                        slv.alertTiming.lastTriggered.push(0);
                    }
                }

                // check all thresholds
                for (let i = tempThreshold.length - 1; i >= 0; i--) {

                    let tempActiveHours = slv.alert.hours[currentDay][i];
                    if (tempActiveHours[0] || tempActiveHours[1]) { //check if not both hours = 0
                        if (currentHour >= tempActiveHours[0] && currentHour < tempActiveHours[1]) {

                            if (inputValue > tempThreshold[i]) {
                                if ((slv.alertTiming.lastTriggered[i] + slv.alert.cd) < Date.now()) {
                                    console.log(slv.alias + "---> Level " + i + " Alert Triggered, val= " + inputValue + " > " + tempThreshold[i]);

                                    let doSkipEmail = skipEmail ? skipEmail[i] : 0;
                                    //console.log(doSkipEmail);
                                    //console.log("--------");
                                    apiSendEmail(slv.alias, Date.now() / 1000, slv.alert.notes, (i + 1), inputValue, tempThreshold[i], doSkipEmail ? null : slv.alert.emails, slv.alert.details);

                                    for (let j = i; j >= 0; j--) { //update threshold and the rest of the lower value
                                        slv.alertTiming.lastTriggered[j] = Date.now();
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
};



for (let slv of slvList) {
    slv.lastIPUpdate = 0;
    slv.lastResponse = 0;
    slv.lastAlertCfg = 0;
    slv.alertTiming = { lastTriggered: [] };

    (function cycle(i) {
        if (slv.staticip) {
            slv.address = slv.staticip;
        }
        if (slv.address) {
            console.log(slv.alias + " @ " + slv.address + " tick: " + i);
            slv.cmd_ms = Date.now();

            let uri = getSlaveUrl(slv.type, slv.address);
            let tempTs, tempTs_current, tempTs_rounded = null;

            axios.get(uri, { timeout: 10000 })
                .then(function (res) {     // handle success
                    let apiOutput = JSON.parse(xmlParser.toJson(res.data));
                    slv.lastResponse = Date.now();
                    checkOtherSlave();
                    checkAlertCfg(slv);
                    //process output
                    switch (slv.type) {
                        case "xvj":
                            tempTs = apiOutput.ResponseXML.StatusData.LocalTime;
                            tempTs_current = Date.parse(tempTs);
                            tempTs_rounded = Math.floor(Date.parse(tempTs) / 60000) * 60000;
                            // if minute change
                            if (slv.max && slv.max.ts != tempTs_rounded) {
                                console.log(slv.alias + " #" + i + "=========Minute Changing===========");
                                console.log(slv.max);

                                if (cfg.main.dbserver.enable) {
                                    let postArg = {
                                        "plc": slv.alias,
                                        "dateTime": slv.max.ts / 1000,
                                        "ch": {
                                            "x": slv.max.x,
                                            "y": slv.max.y,
                                            "z": slv.max.z,
                                            "sumxyz": slv.max.sumxyz,
                                            "s": slv.status.s,
                                            "e": slv.status.e
                                        }
                                    };
                                    let postUri = cfg.main.dbserver.server + "?c=" + JSON.stringify(postArg);
                                    console.log("===>" + slv.alias + " uploading");
                                    axios.get(postUri, { timeout: 5000 }).catch(function (error) { console.log(slv.alias + " API Server error"); });
                                }

                                delete slv.max;
                                delete slv.status;
                                i = 0;
                            }
                            slv.status = slv.status ? slv.status : {
                                s: 0,
                                e: 0
                            };
                            slv.status.s++;
                            slv.max = slv.max ? slv.max : {
                                x: 0,
                                y: 0,
                                z: 0,
                                sumxyz: 0
                            };
                            if (apiOutput.ResponseXML.LoggingData) { //for logging data
                                slv.val = {
                                    x: apiOutput.ResponseXML.LoggingData.Buildings.Internal.PPVix,
                                    y: apiOutput.ResponseXML.LoggingData.Buildings.Internal.PPViy,
                                    z: apiOutput.ResponseXML.LoggingData.Buildings.Internal.PPViz,
                                    sumxyz: apiOutput.ResponseXML.LoggingData.Buildings.Internal.PVSi,
                                    ts: tempTs_current,
                                    latency_ms: (Date.now() - slv.cmd_ms)
                                };
                                slv.max = {
                                    x: slv.max.x < apiOutput.ResponseXML.LoggingData.Buildings.Internal.PPVjx ? apiOutput.ResponseXML.LoggingData.Buildings.Internal.PPVjx : slv.max.x,
                                    y: slv.max.y < apiOutput.ResponseXML.LoggingData.Buildings.Internal.PPVjy ? apiOutput.ResponseXML.LoggingData.Buildings.Internal.PPVjy : slv.max.y,
                                    z: slv.max.z < apiOutput.ResponseXML.LoggingData.Buildings.Internal.PPVjz ? apiOutput.ResponseXML.LoggingData.Buildings.Internal.PPVjz : slv.max.z,
                                    sumxyz: slv.max.sumxyz < apiOutput.ResponseXML.LoggingData.Buildings.Internal.PVSj ? apiOutput.ResponseXML.LoggingData.Buildings.Internal.PVSj : slv.max.sumxyz,
                                    ts: tempTs_rounded
                                };
                            } else if (apiOutput.ResponseXML.ReadyData) { //for ready data //logging not on
                                if (apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVix) {
                                    slv.val = {
                                        x: apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVix,
                                        y: apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPViy,
                                        z: apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPViz,
                                        sumxyz: apiOutput.ResponseXML.ReadyData.Buildings.Internal.PVSi,
                                        ts: tempTs_current,
                                        latency_ms: (Date.now() - slv.cmd_ms)
                                    };
                                    slv.max = {
                                        x: slv.max.x < apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVjx ? apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVjx : slv.max.x,
                                        y: slv.max.y < apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVjy ? apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVjy : slv.max.y,
                                        z: slv.max.z < apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVjz ? apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVjz : slv.max.z,
                                        sumxyz: slv.max.sumxyz < apiOutput.ResponseXML.ReadyData.Buildings.Internal.PVSj ? apiOutput.ResponseXML.ReadyData.Buildings.Internal.PVSj : slv.max.sumxyz,
                                        ts: tempTs_rounded
                                    };
                                } else if (apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVx) { //logging not on
                                    slv.val = {
                                        x: apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVx,
                                        y: apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVy,
                                        z: apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVz,
                                        sumxyz: apiOutput.ResponseXML.ReadyData.Buildings.Internal.PVS,
                                        ts: tempTs_current,
                                        latency_ms: (Date.now() - slv.cmd_ms)
                                    };
                                    slv.max = {
                                        x: slv.max.x < apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVx ? apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVx : slv.max.x,
                                        y: slv.max.y < apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVy ? apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVy : slv.max.y,
                                        z: slv.max.z < apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVz ? apiOutput.ResponseXML.ReadyData.Buildings.Internal.PPVz : slv.max.z,
                                        sumxyz: slv.max.sumxyz < apiOutput.ResponseXML.ReadyData.Buildings.Internal.PVS ? apiOutput.ResponseXML.ReadyData.Buildings.Internal.PVSj : slv.max.PVS,
                                        ts: tempTs_rounded
                                    };
                                }

                            }

                            //update websocket
                            if (cfg.main.websocket.enable) {
                                socket.emit('senddata', slv.val, slv.alias);
                            }
                            console.log(slv.alias + " replies, latency: " + slv.val.latency_ms + " ms");
                            //console.log(slv);
                            checkValueAlert(slv, slv.max.sumxyz);
                            break;
                        case "xnj":
                            tempTs = apiOutput.data.General.Time;
                            tempTs_current = Date.parse(tempTs);
                            tempTs_rounded = Math.floor(Date.parse(tempTs) / 60000) * 60000;
                            if (slv.max && slv.max.ts != tempTs_rounded) {
                                console.log(slv.alias + " #" + i + "=========Minute Changing===========");
                                console.log(slv.max);

                                if (cfg.main.dbserver.enable) {
                                    let postArg = {
                                        "plc": slv.alias,
                                        "dateTime": slv.max.ts / 1000,
                                        "ch": {
                                            "las": slv.max.las,
                                            "leq": slv.max.leq, //10 * Math.log10(slv.max.leq/slv.status.s), //added
                                            "s": slv.status.s,
                                            "e": slv.status.e
                                        }
                                    };
                                    let postUri = cfg.main.dbserver.server + "?c=" + JSON.stringify(postArg);
                                    console.log("===>" + slv.alias + " uploading");
                                    axios.get(postUri, { timeout: 5000 }).catch(function (error) { console.log(slv.alias + " API Server error"); });;
                                }

                                delete slv.max;
                                delete slv.status;
                                i = 0;
                            }
                            slv.status = slv.status ? slv.status : {
                                s: 0,
                                e: 0,
                                l: 0
                            };
                            slv.status.s++;
                            if (!slv.hasOwnProperty('max')) {
                                slv.max = {
                                    las: 0,
                                    leq: 0
                                };
                            }
                            /*slv.max = slv.max ? slv.max : {
                                las: 0,
                                leq: 0
                            };*/
                            let tempValues = apiOutput.data.rt.instant.split(";");
                            slv.val = {
                                las: parseFloat(tempValues[0]),
                                leq: parseFloat(tempValues[2]),
                                ts: tempTs_current,
                                latency_ms: (Date.now() - slv.cmd_ms)
                            };
                            //-----
                            /*let tempLeq10th = 0;
                            if (tempTs_rounded % holdData_delay === 0){
                                tempLeq10th =  10**(tempValues[3] / 10);
                                slv.status.l++;
                            }*/
                            //-----
                            slv.max = {
                                las: slv.max.las < tempValues[1] ? tempValues[1] : slv.max.las,
                                leq: tempValues[3], // slv.max.leq + tempLeq10th, /// added
                                ts: tempTs_rounded
                            }
                            //update websocket
                            if (cfg.main.websocket.enable) {
                                socket.emit('senddata', slv.val, slv.alias);
                            }
                            console.log(slv.alias + " replies, latency: " + slv.val.latency_ms + " ms");
                            //console.log(slv);
                            //---------------------------------------------------------------------------------------------------------may add leq here for alarm
                            checkValueAlert(slv, slv.max.leq);
                            break;
                        default:
                            console.log(apiOutput);
                    }
                })
                .catch(function (error) {   // handle error
                    console.log(slv.alias + " Polling Error: " + error.message);
                    //clear ip address if timeout and last IP address was longer reconnect delay
                    if (slv.lastIPUpdate && (Date.now() - slv.lastIPUpdate) > reconnect_delay) {
                        //slv.address = null;
                        delete slv.address;
                    }
                })
                .then(function () {
                    setTimeout(cycle, idle_ms, i + 1);
                });
        } else if ((Date.now() - slv.lastIPUpdate) > reconnect_delay) {
            slv.lastIPUpdate = Date.now();
            if (slv.hasOwnProperty('staticip')) {
                slv.address = slv.staticip;
            } else {
                console.log("Getting Ip for: " + slv.simid);
                let ispRequest = 'https://smp.jasperwireless.com/provision/api/v1/sims/searchDetails?search=[{"property":"simId","type":"LONG_EQUALS","value":' + slv.simid + ',"id":"simId"}]';
                axios.get(ispRequest,
                    {
                        auth: {
                            username: cfg.main.isp.username ? cfg.main.isp.username : "",
                            password: cfg.main.isp.password ? cfg.main.isp.password : ""
                        },
                        timeout: 5000
                    })
                    .then(function (res) {     // handle success
                        slv.address = res.data.data[0].currentSessionInfo.deviceIpAddress;
                        if (!slv.address) {
                            slv.address = res.data.data[0].ipAddress;
                        }
                        console.log("ISP IP Update successfull");
                        console.log(slv);
                    })
                    .catch(function (error) {   // handle error
                        console.log("ISP Error for: " + slv.simid);
                    })
                    .then(function () {    // always executed
                        setTimeout(cycle, idle_ms, i);
                    });
            }
        } else {
            setTimeout(cycle, idle_ms, i);
        }
    })(0);
}