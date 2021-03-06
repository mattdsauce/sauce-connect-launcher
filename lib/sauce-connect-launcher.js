var
  fs = require("fs"),
  path = require("path"),
  rimraf = require("rimraf"),
  os = require("os"),
  _ = require("lodash"),
  async = require("async"),
  https = require("https"),
  HttpsProxyAgent = require("https-proxy-agent"),
  AdmZip = require("adm-zip"),
  spawn = require("child_process").spawn,
  exec = require("child_process").exec,
  crypto = require("crypto"),
  processOptions = require("./process_options"),
  versionsfile,
  archivefile,
  scDir = path.normalize(__dirname + "/../sc"),
  exists = fs.existsSync || path.existsSync,
  currentTunnel,
  logger = console.log,
  cleanup_registered = false,
  sc_version = process.env.SAUCE_CONNECT_VERSION ||
    require("../package.json").sauceConnectLauncher.scVersion,
  sc_checksum,
  tunnelIdRegExp = /Tunnel ID:\s*([a-z0-9]+)/i,
  portRegExp = /port\s*([0-9]+)/i,
  tryRun = require("./try_run");

function setWorkDir(workDir) {
  scDir = workDir;
}

function killProcesses(callback) {
  callback = callback || function () {};

  if (!currentTunnel) {
    return callback();
  }

  currentTunnel.on("close", function () {
    currentTunnel = null;
    callback();
  });
  currentTunnel.kill("SIGTERM");
}

function clean(callback) {
  async.series([
    killProcesses,
    function (next) {
      rimraf(scDir, next);
    }
  ], callback);
}

function getArchiveName() {
  return {
    darwin: "sc-" + sc_version + "-osx.zip",
    win32: "sc-" + sc_version + "-win32.zip"
  }[process.platform] || "sc-" + sc_version + "-linux.tar.gz";
}

function getScFolderName() {
  return {
    darwin: "sc-" + sc_version + "-osx",
    win32: "sc-" + sc_version + "-win32"
  }[process.platform] || "sc-" + sc_version + "-linux";
}

function getScBin() {
  var exe = process.platform === "win32" ? ".exe" : "";
  return path.normalize(scDir + "/" + getScFolderName() + "/bin/sc" + exe);
}

// Make sure all processes have been closed
// when the script goes down
function closeOnProcessTermination() {
  if (cleanup_registered) {
    return;
  }
  cleanup_registered = true;
  process.on("exit", function () {
    logger("Shutting down");
    killProcesses();
  });
}

function unpackArchive(callback) {
  logger("Unzipping " + getArchiveName());
  setTimeout(function () {
    if (archivefile.match(/\.tar\.gz$/)) {
      exec("tar -xzf '" + archivefile + "'", {cwd: scDir}, callback);
    } else {
      try {
        var zip = new AdmZip(archivefile);
        zip.extractAllTo(scDir, true);
      } catch (e) {
        return callback(new Error("ERROR Unzipping file: ", e.message));
      }
      callback(null);
    }
  }, 1000);
}

function setExecutePermissions(callback) {
  if (os.type() === "Windows_NT") {
    // No need to set permission for the executable on Windows
    callback(null);
  } else {
    // check current permissions
    fs.stat(getScBin(), function (err, stat) {
      if (err) { return callback(new Error("Couldn't read sc permissions: " + err.message)); }

      if (stat.mode.toString(8) !== "100755") {
        fs.chmod(getScBin(), 0755, function (err) {
          if (err) { return callback(new Error("Couldn't set permissions: " + err.message)); }
          callback(null);
        });
      } else {
        callback(null);
      }
    });
  }
}

function httpsRequest(options) {
  // Optional http proxy to route the download through
  // (if agent is undefined, https.request will proceed as normal)
  var proxy = process.env.https_proxy || process.env.http_proxy;
  var agent;
  if (proxy) {
    agent = new HttpsProxyAgent(proxy);
  }

  options = options || {};
  options.agent = agent;
  options.timeout = 30000;

  return https.request(options);
}

function verifyChecksum(cb) {
  var fd = fs.createReadStream(archivefile);
  var hash = crypto.createHash("sha1");
  hash.setEncoding("hex");

  hash.on("end", function() {
    hash.end();

    var sha1 = hash.read();
    if (sha1 !== sc_checksum) {
      cb(new Error("Checksum of the downloaded archive (" + sha1 + ") doesn't match (" + sc_checksum + ")."));
    }

    cb();
  });

  fd.pipe(hash);
}

function fetchAndUnpack(options, callback) {
  var req = httpsRequest({
      host: "saucelabs.com",
      port: 443,
      path: "/downloads/" + getArchiveName()
    });

  function removeArchive() {
    try {
      logger("Removing " + archivefile);
      fs.unlinkSync(archivefile);
    } catch (e) {}
    _.defer(process.exit.bind(null, 0));
  }

  // synchronously makes sure the file exists, so that we don't re-enter
  // in this function (which is only called when the file does not exist yet)
  fs.writeFileSync(archivefile, "");

  logger("Missing Sauce Connect local proxy, downloading dependency");
  logger("This will only happen once.");

  req.on("response", function (res) {
    var len = parseInt(res.headers["content-length"], 10),
      prettyLen = (len / (1024 * 1024) + "").substr(0, 4);

    logger("Downloading " + prettyLen + "MB");

    res.pipe(fs.createWriteStream(archivefile));

    // cleanup if the process gets interrupted.
    process.on("exit", removeArchive);
    process.on("SIGHUP", removeArchive);
    process.on("SIGINT", removeArchive);
    process.on("SIGTERM", removeArchive);

    function done(err) {
      if (err) { return callback(new Error("Couldn't unpack archive: " + err.message)); }
      // write queued data before closing the stream
      logger("Removing " + getArchiveName());
      fs.unlinkSync(archivefile);
      logger("Sauce Connect downloaded correctly");
      callback(null);
    }

    res.on("end", function () {
      if (sc_checksum) {
        async.waterfall([
          async.apply(verifyChecksum),
          async.apply(unpackArchive),
        ], done);
      }

      unpackArchive(done);
    });

  });

  req.end();
}

function scPlatform() {
  return {
    darwin: "osx",
    win32: "win32",
  }[process.platform] || "linux";
}

function getVersions(cb) {
  function done(err) {
    if (err) {
      return cb(err);
    }

    var versions = require(versionsfile)["Sauce Connect"];

    sc_version = versions["version"];
    sc_checksum = versions[scPlatform()]["sha1"];

    return cb();
  }

  if (sc_version !== "latest") {
    logger("Checksum check for manually overwritten sc versions isn't supported.");
    return done();
  }

  if (exists(versionsfile)) {
    return done();
  }

  var req = httpsRequest({
      host: "saucelabs.com",
      port: 443,
      path: "/versions.json"
    });

  req.on("response", function (res) {
    if (res.statusCode !== 200) {
      return done(new Error("Fetching https://saucelabs.com/versions.json failed: " + res.statusCode));
    }

    var file = fs.createWriteStream(versionsfile);

    res.pipe(file);

    file.on("error", function (err) {
      done(err);
    });

    file.on("close", function () {
      done();
    });

  });

  req.end();
}

function download(options, callback) {
  if (arguments.length === 1) {
    callback = options;
    options = {};
  }
  logger = options.logger || function () {};

  if (options.exe) {
    return callback(null);
  }

  if (!fs.existsSync(scDir)) {
    fs.mkdirSync(scDir);
  }

  function checkForArchive(next) {
    if (!exists(archivefile)) {
      fetchAndUnpack(options, next);
    } else {
      // the zip is being downloaded, poll for the binary to be ready
      async.doUntil(function wait(cb) {
        _.delay(cb, 1000);
      }, async.apply(exists, getScBin()), next);
    }
  }

  async.waterfall([
    getVersions,
    function checkForBinary(next) {
      if (exists(getScBin())) {
        next(null);
      } else {
        checkForArchive(next);
      }
    },
    async.apply(setExecutePermissions),
  ], callback);
}

function connect(options, callback) {
  var child;
  var logger = options.logger || function () {};
  callback = _.once(callback);

  function ready() {
    logger("Testing tunnel ready");
    closeOnProcessTermination();
    callback(null, child);
  }

  logger("Opening local tunnel using Sauce Connect");
  var watcher,
    readyfile,
    readyFileName = "sc-launcher-readyfile",
    args = processOptions(options),
    error,
    handleError = function (data) {
      if (data.indexOf("Not authorized") !== -1 && !error) {
        logger("Invalid Sauce Connect Credentials");
        error = new Error("Invalid Sauce Connect Credentials. " + data);
      } else if (data.indexOf("Sauce Connect could not establish a connection") !== -1) {
        logger("Sauce Connect API failure");
        error = new Error(data);
      } else if (data.indexOf("HTTP response code indicated failure") === -1) {
        // sc says the above before it says "Not authorized", but the following
        // Error: message is more useful
        error = new Error(data);
      }
      // error will be handled in the child.on("exit") handler
    },
    dataActions = {
      "Please wait for 'you may start your tests' to start your tests": function connecting() {
        logger("Creating tunnel with Sauce Labs");
      },
      "Tunnel ID:": function (data) {
        var tunnelIdMatch = tunnelIdRegExp.exec(data);
        if (tunnelIdMatch) {
          child.tunnelId = tunnelIdMatch[1];
        }
      },
      "Selenium listener started on port": function (data) {
         var portMatch = portRegExp.exec(data);
         if (portMatch) {
           child.port = parseInt(portMatch[1], 10);
         }
      },
      //"you may start your tests": ready,
      "This version of Sauce Connect is outdated": function outdated() {

      },
      "Error: ": handleError,
      "Error bringing": handleError,
      "Sauce Connect could not establish a connection": handleError,
      "{\"error\":": handleError,
      "Goodbye.": function shutDown() {

      }
  },
  previousData = "",
  killProcessTimeout = null,
  killProcess = function () {
    if (child) {
      child.kill("SIGTERM");
    }
  };

  if (options.readyFileId) {
    readyFileName = readyFileName + "_" + options.readyFileId;
  }

  // Node v0.8 uses os.tmpDir(), v0.10 uses os.tmpdir()
  readyfile = path.normalize((os.tmpdir ? os.tmpdir() : os.tmpDir()) +
    "/" + readyFileName);

  args.push("--readyfile", readyfile);

  // Watching file as directory watching does not work on
  // all File Systems http://nodejs.org/api/fs.html#fs_caveats
  watcher = fs.watchFile(readyfile, function () {
    fs.exists(readyfile, function (exists) {
      if (exists) {
        logger("Detected sc ready");
        ready();
      }
    });
  });

  watcher.on("error", callback);

  logger("Starting sc with args: " + args
    .join(" ")
    .replace(/-u\ [^\ ]+\ /, "-u XXXXXXXX ")
    .replace(/-k\ [^\ ]+\ /, "-k XXXXXXXX ")
    .replace(/[0-9a-f]{8}\-([0-9a-f]{4}\-){3}[0-9a-f]{12}/i,
      "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXX"));

  var exe;
  if (options.exe) {
    exe = options.exe;
  } else {
    exe = getScBin();
  }

  child = spawn(exe, args);

  currentTunnel = child;

  child.stdout.on("data", function (data) {
    previousData += data.toString();
    var lines = previousData.split("\n");
    previousData = lines.pop();
    // only process full lines
    _.each(lines, function (line) {
      line = line.trim();
      if (line === "") {
        return;
      }
      if (options.verbose) {
        logger(line);
      }
      _.each(dataActions, function (action, key) {
        if (line.indexOf(key) !== -1) {
          action(line);
          return false;
        }
      });
    });
  });

  child.on("error", function (err) {
    logger("Sauce connect process errored: " + err);

    fs.unwatchFile(readyfile);
    return callback(err);
  });

  child.on("exit", function (code, signal) {
    currentTunnel = null;
    child = null;
    if (killProcessTimeout) {
      clearTimeout(killProcessTimeout);
      killProcessTimeout = null;
    }

    fs.unwatchFile(readyfile);

    if (error) { // from handleError() above
      return callback(error);
    }

    var message = "Closing Sauce Connect Tunnel";
    if (code > 0) {
      message = "Could not start Sauce Connect. Exit code " + code +
        " signal: " + signal;
      callback(new Error(message));
    }
    logger(message);
  });

  child.close = function (closeCallback) {
    if (closeCallback) {
      child.on("exit", function () {
        closeCallback();
      });
    }
    var tunnelId = child.tunnelId;
    if (tunnelId) {
      // rather than killing the process immediately, make a request to close the tunnel,
      // and give some time to the process to shutdown by itself
      httpsRequest({
        method: "DELETE",
        host: "saucelabs.com",
        port: 443,
        auth: options.username + ":" + options.accessKey,
        path: "/rest/v1/" + options.username + "/tunnels/" + tunnelId
      }).on("response", function (res) {
        if (child) {
          // give some time to the process to shut down by itself
          killProcessTimeout = setTimeout(killProcess, 5000);
        }
        res.resume(); // read the full response to free resources
      }).on("error", killProcess).end();
    } else {
      killProcess();
    }
  };
}




function run(options, callback) {
  tryRun(0, options, connect, callback);
}

function downloadAndRun(options, callback) {
  if (arguments.length === 1) {
    callback = options;
    options = {};
  }
  logger = options.logger || function () {};

  async.waterfall([
    async.apply(download, options),
    async.apply(run, options),
  ], callback);
}

versionsfile = path.normalize(scDir + "/versions.json");
archivefile = path.normalize(scDir + "/" + getArchiveName());

module.exports = downloadAndRun;
module.exports.download = download;
module.exports.kill = killProcesses;
module.exports.getArchiveName = getArchiveName;
module.exports.clean = clean;
module.exports.setWorkDir = setWorkDir;
