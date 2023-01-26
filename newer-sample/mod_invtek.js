/*
Partial code to read and adjust an inverter via modbus-rtu depending on delta Temperature of 2 sensors
*/

class comp {
    constructor() {
        this.mb_list = [
            {
                "address": 6,
                "name": "f",
                "note": "hz",
                "function": 4,
                "tens": 1
            },
            {
                "address": 7,
                "name": "i",
                "note": "current",
                "function": 4,
                "tens": 1
            },
            {
                "address": 9,
                "name": "p",
                "note": "watt",
                "function": 4,
                "tens": 1
            },
            {
                "address": 13,
                "name": "v",
                "note": "volts",
                "function": 4,
                "tens": 1
            },
            {
                "address": 14,
                "name": "torque",
                "note": "Nm",
                "function": 4,
                "tens": 1
            },
            {
                "address": 23,
                "name": "t",
                "note": "celcius",
                "function": 4,
                "tens": 0
            },
            {
                "address": 1,
                "name": "freff",
                "note": "hz",
                "function": 6,
                "tens": 0
            }
        ];

    }
    async calculateLogic(logic, devGlobalList) {
        console.log(logic);

        if (logic.fforce != null) {
            if (logic.fforce > logic.fmax) return logic.fmax * 10;
            if (logic.fforce < logic.fmin) return logic.fmin * 10;
            return logic.fforce * 10;
        }

        let t0 = await devGlobalList.getDevValue(logic.t0);
        let t1 = await devGlobalList.getDevValue(logic.t1);
        let freff = await devGlobalList.getDevValue(logic.freff);

        if (freff == undefined || t0 == undefined || t1 == undefined) return null;

        let dt = Math.abs(t0 - t1);

        //check if freff is at or out of bound (safety)
        if (freff >= logic.fmax || (freff * 10) + logic.step >= logic.fmax * 10) {
            console.log("over top limit " + freff);
            return logic.fmax * 10;
        }
        if (freff <= logic.fmin || (freff * 10) - logic.step <= logic.fmin * 10) {
            console.log("over bottom limit " + freff);
            return logic.fmin * 10;
        }

        if (dt > logic.target) {
            console.log("dt:" + dt + " increasing");
            console.log(freff);
            console.log(logic.step);
            return (freff * 10) + logic.step;
        }
        if (dt < logic.target) {
            console.log("dt:" + dt + " decreasing");
            console.log(freff);
            console.log(logic.step);
            return (freff * 10) - logic.step;
        }

        return (freff * 10);
    }
}
module.exports = comp;