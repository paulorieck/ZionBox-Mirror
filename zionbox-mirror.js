const fs = require('fs');
const path = require('path');
const os = require('os');
const find_process = require('find-process');

const express = require("express");

var app = express();

app.use(express.static('www'));

const http = require('http');
var server = http.createServer(app);

var bodyParser = require('body-parser');
app.use(bodyParser.json()); // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({extended: true})); // to support URL-encoded bodies

var ids_list = [];

var homedir = os.homedir();
if ( !fs.existsSync(path.join(homedir, ".zionbox-mirror")) ) {
    fs.mkdirSync(path.join(homedir, ".zionbox-mirror"));
}

var confs = JSON.parse(
    fs.readFileSync(
        path.join(homedir, ".zionbox-mirror/configs.json")
    )
);

var ipfs;
if ( confs.ipfsAPI !== "" && typeof confs.ipfsAPI !== "undefined" ) {

    const ipfsAPI = require('ipfs-http-client');
    ipfs = ipfsAPI(confs.ipfsAPI);

} else {

    var homedir = os.homedir();
    if ( !fs.existsSync(path.join(homedir, ".zionbox-mirror/ipfsdata")) ) {
        fs.mkdirSync(path.join(homedir, ".zionbox-mirror/ipfsdata"));
    }

    const IPFS = require('ipfs');
    ipfs = new IPFS({repo: path.join(homedir, ".zionbox-mirror/ipfsdata")});

    ipfs.on('ready', () => {
        //callback();
    });

}

var devnull = require('dev-null');

const Datastore = require('nedb');
const synchronized = new Datastore({filename: 'nedbs/synchronized.db', autoload: true});

setInterval(function () {

    for (var i = 0; i < ids_list.length; i++) {
        if ( !ids_list[i].processing && ids_list[i].list.length > 0 ) {
            
            ids_list[i].processing = true;
            processStructure(0, ids_list[i].list, ids_list[i].id, function () {
                
            });

        }
    }

}, 10000);

function processStructure(counter, hashes, id, callback) {

    synchronizeObject(hashes[counter], id, function () {

        counter++;

        if ( counter < hashes.length ) {
            processStructure(counter, hashes, id, function () {
                callback();
            });
        } else {

            for (var i = 0; i < ids_list.length; i++) {
                if ( ids_list[i].id === id ) {
                    ids_list[i].processing = false;
                    break;
                }
            }

            callback();
        }

    });

}

app.post("/processStructure/", function (req, res) {

    console.log("Received procesStructure!");
    res.send("Success");

    var hashes = req.body.hashes;
    var id = req.body.id;

    var id_exists = false;
    for (var i = 0; i < ids_list.length; i++) {
        if ( ids_list[i] === id ) {
            id_exists = true;
            break;
        }
    }

    if ( !id_exists ) {
        ids_list.push({"id": id, "list": [], "size": 0, "processing": false});
    }

    for (var i = 0; i < ids_list.length; i++) {
        if ( ids_list[i].id === id ) {
            for (var j = 0; j < hashes.length; j++) {
                ids_list[i].list.push(hashes[j].hash);
            }
            console.log("ids_list[i].list: ");
            console.log(ids_list[i].list);
            break;
        }
    }

});

function synchronizeObject(hash, id, callback) {

    // Check if object is already synchronized
    synchronized.find({"hash": hash}, function (error, docs) {
        
        if ( error ) {
            
            console.log("Error:");
            console.log(error);

            callback(error);

        } else {

            var now = (new Date()).getTime();

            if ( docs.length > 0 ) { // Exists

                var doc = docs[0];
                synchronized.update({_id: doc._id}, {$set: {last_access: now}}, {multi: false}, function (err, numReplaced) {
                    if ( err ) {
                        console.log("Error: "+err);
                        callback();
                    } else {
                        callback();
                    }
                });

                // Remove the object from the processing list
                for (var i = 0; i < ids_list.length; i++) {
                    if ( ids_list[i].id === id ) {
                        for (var j = 0; j < ids_list[i].list.length; j++) {
                            if ( ids_list[i].list[j] === hash ) {
                                console.log("Removing from list: "+ids_list[i].list[j]);
                                ids_list[i].list.splice(j,1);
                                j--;
                                break;
                            }
                        }
                        break;
                    }
                }

            } else { // Does not exists

                console.log("Will locally synchronize the hash: "+hash);

                try {

                    // Cat content
                    var readableStream = ipfs.catReadableStream(hash);

                    readableStream.pipe(devnull());

                    var last_package_time = 0;
                    readableStream.on('data',function () {
                        last_package_time = (new Date()).getTime();
                    });

                    var timer = setInterval(function () {
                        if ( last_package_time !== 0 && (new Date()).getTime() - last_package_time > 60000 ) {
                            console.log("Timeout! The object '"+hash+"' is not completely downloaded!");
                            callback();
                        }
                    }, 30000);

                    readableStream.on('end',function () {

                        clearInterval(timer);

                        // Remove the object from the processing list
                        for (var i = 0; i < ids_list.length; i++) {
                            if ( ids_list[i].id === id ) {
                                for (var j = 0; j < ids_list[i].list.length; j++) {
                                    if ( ids_list[i].list[j] === hash ) {
                                        console.log("Removing from list: "+ids_list[i].list[j]);
                                        ids_list[i].list.splice(j,1);
                                        j--;
                                        break;
                                    }
                                }
                                break;
                            }
                        }
                    
                        synchronized.insert({"hash": hash, "last_access": now}, function (error, newDoc) {

                            if ( error ) {

                                console.log("Error:");
                                console.log(error);

                                callback(error);

                            } else {

                                ipfs.pin.add(hash.hash, function () {
                                });

                                callback();

                            }

                        });

                    });

                } catch (Error) {

                }

            }

        }
        
    });

}

app.post("/synchronizeObject/", function (req, res) {

    console.log("Received synchronizeObject!");

    var hash = req.body.hash;
    var id = req.body.id;

    var id_exists = false;
    for (var i = 0; i < ids_list.length; i++) {
        if ( ids_list[i] === id ) {
            id_exists = true;
            break;
        }
    }

    if ( !id_exists ) {
        ids_list.push({"id": id, "list": [], "size": 0, "processing": false});
    }

    for (var i = 0; i < ids_list.length; i++) {
        if ( ids_list[i].id === id ) {
            ids_list[i].list.push(hash);
            break;
        }
    }

    res.send("Success");

});

app.post("/desynchronizeObject/", function (req, res) {

    console.log("Received desynchronizeObject!");

    var hash = req.body.hash;

    synchronized.remove({"hash": hash}, {}, function (err, numRemoved) {

        ipfs.pin.rm(hash, function () {});
        res.send("Success");

    });

});

server.listen(confs.mirror_port, function () {
    console.log('IPFSSyncro Web Server listening on port '+confs.mirror_port+'!');
});

function main() {

    // Check if the IPFS is running
    find_process('name', 'ipfs')
        .then(function (list) {

            var isRunning = false;
            for (var i = 0; i < list.length; i++) {

                if ( list[i].name === "ipfs" || list[i].name === "ipfs.exe" || list[i].name === "IPFS Desktop" ) {
                    console.log(list[i].name+" is running!");
                    isRunning = true;
                }

            }
            console.log("isRunning: "+isRunning);
            
            if ( !isRunning ) { // If not running, starts ipfs daemon

                var exec = require('child_process').exec;
                var ipfsExec = exec('ipfs daemon');

                ipfsExec.stdout.on('data', function (logs) {
                    
                    console.log("ipfs daemon logs: "+logs);

                });

            }

        }, function (err) {
            console.log(err.stack || err);
        })

}
main();