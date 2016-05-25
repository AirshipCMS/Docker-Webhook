'use strict';

const webhook = require('docker-webhook');
const Promise = require('bluebird');
const URL = require('url');
const exec = require('child_process').exec;
const fs = require('fs');
const request = require('request');
const INACTIVE_TIMEOUT = 600000; // ms, 10 mins
const DELAY_AFTER_ACTIVE = 30000; // ms, 30 seconds
const ATTEMPTS_AFTER_ACTIVE = 5; // attempts to ping server, with between DELAY_AFTER_ACTIVE
const VERSION_ENDPOINT = '/_version';
const VERSION_FILENAME = 'VERSION.json';
const {
  TEST = false,
  AUTH_TOKEN,
  FLEETCTL_ENDPOINT,
  SLACK_NOTIFICATION,
  REPO_NAME,
  TAG,
  UNITS_CONFIG_PATH = '/srv/units.json',
} = process.env;
// const FLEETCTL_CMD = `/bin/fleetctl --endpoint ${FLEETCTL_ENDPOINT}`;
const FLEETCTL_CMD = `/bin/fleetctl`;
const queue = [];
let is_updating = false;

function fleetctl( cmd ){
  return exec(
    TEST ?
      `/bin/echo "\n\n===== ${FLEETCTL_CMD} ${cmd} =====\n"` :
      `/bin/echo "\n\n===== ${FLEETCTL_CMD} ${cmd} =====\n" && ${FLEETCTL_CMD} ${cmd}`
  );
}

function promiseFromExec(child){
  return new Promise(function(resolve, reject){
    child.stderr.pipe(process.stderr);
    child.stdout.pipe(process.stdout);
    child.addListener('error', function(err){
      reject( err.message );
    });
    child.addListener('exit', function(code,signal){
      if(code === 0){
        resolve( code );
      }else{
        reject( code );
      }
    });
  });
}

function promiseOutputFromExec(child){
  return new Promise(function(resolve, reject){
    child.stderr.pipe(process.stderr);
    var data = "";
    child.stdout.on('data', function(chunk){
      data += chunk;
    })
    child.addListener('error', function(err){
      reject({ message : err.message, unit : unit});
    });
    child.addListener('exit', function(code,signal){
      data = data.trim();
      if(code === 0){
        resolve(data);
      }else{
        reject(data);
      }
    });
  });
}

// function etcdPathToFleetUnit(path){
//   return path.replace("/airship/drone/","drone@").replace("/airship/app/","airship@").replace("/airship/nginx/http/","nginx@");
// }

/**
 * for TEST only
 */
function getVersionTEST(){
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if(Math.floor(Math.random() * 2) == 0){
        resolve({"API_VERSION_TAG":"v20164131434","VERSION_TAG":"20164121528","VERSION_CODE":"BE0TEST","API_VERSION_CODE":"BE1TEST"});
      } else {
        reject("Error: connect ETIMEDOUTEST 10.1.1.214:3892");
      }
    }, 900);
  });
}

/**
 * get versions in different ways
 * if http, (airship || nginx)
 *   get version from [ipv4_addr]:[port]/_version
 * if drone
 *   get version from docker exec [port] cat VERSION.json
 *   `fleetctl ssh drone@1 docker exec drone_1 cat VERSION.json`
 */
function getVersion( unit, attempts ) {
  if ( TEST ) {
    return getVersionTEST();
  } else if ( unit.type === "drone" ) {
    return promiseOutputFromExec(
      fleetctl(`ssh ${unit.unit} docker exec ${unit.port} cat ${VERSION_FILENAME}`)
    );
  } else { // "api" or "static"
    return new Promise((resolve, reject) => {
      var unit_url = URL.parse(`http://${unit.ipv4_addr}:${unit.port}/${VERSION_ENDPOINT}`);
      request.get({
        url : unit_url,
        json : true,
        headers : {
          "Host" : "localhost"
        }
      },
      (error, response, body) => {
        if ( error ) {
          reject(error);
        } else if ( response.statusCode != 200 ) {
          reject( JSON.stringify(response) );
        } else {
          resolve(body);
        }
      });
    });
  }
}

/**
 * format message for slack messaging
 */
function reportComplete(unit, body){
  var fields = [
    {
      title : `API Version${ unit.type === "api" ? " [updated]" : "" }`,
      value : `${body.API_VERSION_TAG} ${body.API_VERSION_CODE}`,
      short : true
    },
    {
      title : `Admin Version${ unit.type === "static" ? " [updated]" : "" }`,
      value : `${body.VERSION_TAG} ${body.VERSION_CODE}`,
      short : true
    }
  ];
  slack.success( unit, fields );
  process.stdout.write( 'Updated Version : '+JSON.stringify(body)+'\n' );
}

/**
 *
 * for each unit defined in units : ['airship@1','airship@2','drone@1','drone@2']
 *   update each one, recursively shifting
 *   on completion of each unit,
 *   if queue.length is > 0
 *     start all over, performUpdate()
 * when this finishes, unset is_updating flag
 */
function incrementallyUpdateUnits( units ){
  if(units.length > 0){
    var unit = units.shift();

    // each unit runs 2 commands, stop then start
    return promiseFromExec(
      fleetctl(`stop ${unit.unit} && sleep 10`)
    ).then( code => {
      process.stdout.write(`Upgrade-> STOPPED unit ${unit.unit} with exit code: ${code}\n`);
      return promiseFromExec(
        fleetctl(`start ${unit.unit}`)
      );
    }).then( code => {
      process.stdout.write(`Upgrade-> STARTED stopped unit ${unit.unit}, completed with exit code: ${code}\n`);
      process.stdout.write(`waiting for update...`);

      if(queue.length > 0){
        process.stdout.write(`Update chain interrupted, ${queue.length} new requests in queue, starting over.\n`);
        performUpdate();
      } else {
        process.stdout.write(`Update chain continuing.\n`);
        var start = Date.now();
        var now = start;
        var active = false;
        var checker = setInterval(() => {
          now = Date.now();
          if( now - start < INACTIVE_TIMEOUT ){
            if( !active ){
              getVersion(unit)
              .then( version => {
                  active = true;
                  clearInterval(checker);
                  reportComplete(unit, version);
                  unitUpdated(units); // continue
              }, versionError => {
                // wait
                process.stderr.write( `Get Updated Version : ${unit.unit} failed after ${ (now - start) / 1000 }s\n${versionError}\n\n` );
              });
            }
          }else{
            slack.error( `Upgrade-> timeout error: unit ${unit.unit} never became active\nFailed to get updated version after : ${INACTIVE_TIMEOUT / 1000}s` );
            process.stderr.write(`Upgrade-> timeout error: unit ${unit.unit} never became active\n\n`);
            clearInterval(checker);
            // unitUpdated(units); // don't continue, assume bad update, so leave dead and don't continue
          }
        }, 1000);
      }

    }, err => {
      process.stderr.write('Upgrade-> error: ' + err.message + '\n\n');
      slack.fail( err.message );
      // unitUpdated(units); // don't continue, assume bad update, so leave dead and don't continue
    });

  } else { // done
    is_updating = false;
    if(queue.length > 0){
      performUpdate();
    }
  }
}

function unitUpdated( units ){
  if(queue.length > 0){
    performUpdate(); // start over
  } else {
    incrementallyUpdateUnits(units); // continue
  }
}

/**
 * drain queue
 * enable is_updating flag
 * start from first unit in line
 */
function performUpdate(){
  if( queue.length > 0 ){
    process.stdout.write(`Draining queue: ${queue}\n`);
    queue.splice(0);
  } else {
    process.stdout.write(`Queue is empty\n`);
  }

  is_updating = true;

  try{
    let unitsJson = JSON.parse( fs.readFileSync(UNITS_CONFIG_PATH) );
    incrementallyUpdateUnits( unitsJson.filter(u => u !== null) );
  }catch(e){
    process.stderr.write(
      `failed to read and parse ${UNITS_CONFIG_PATH}\nDID NOT PERFORM UPDATE!!!\n`
    );
    console.error(e);
  }
}

/**
 * if is_updating, add to queue
 * else perform update
 */
function requestUpdate(){
  if( is_updating ){
    queue.push(new Date());
  } else {
    performUpdate();
  }
}

webhook(function cb(json, url) {
  var url_auth_token = URL.parse(url).path.substr(1);
  if( url_auth_token === AUTH_TOKEN ){
    // authorized to run hook commands
    if( json.hasOwnProperty('repository') &&
        json.repository.hasOwnProperty('repo_name') &&
        json.hasOwnProperty('push_data') &&
        json.push_data.hasOwnProperty('tag') &&
        json.repository.repo_name === REPO_NAME &&
        json.push_data.tag === TAG
    ){

      requestUpdate();

    }else{

      process.stderr.write(
        // slack.error( 'got bad payload?, did nothing \n' + url + '\n' + JSON.stringify(json) + '\n')
        'mismatched TAG or REPO_NAME, or got bad payload? ignoring. \n' + url + '\n' + JSON.stringify(json) + '\n'
      );
    }
  }else{

    // health check?

    // process.stderr.write(
    //   slack.error( 'got request, did nothing \n' + url + '\n' + json + '\n' )
    // );
  }
});

var slack = {
  status : {
    SUCCESS : "success",
    FAIL : "failed",
    ERROR : "error"
  },
  success : function( unit, fields ){
    slack.notify( slack.status.SUCCESS, unit, null, fields );
  },
  fail : function( result ){
    slack.notify( slack.status.FAIL, result.unit );
  },
  error : function( message ){
    slack.notify( slack.status.ERROR, null, message );
    return message;
  },
  notify : function( status, unit, message, appendFields ){

    if( SLACK_NOTIFICATION !== undefined ){
      var color = status === "success" ? "good" : "danger";
      var slackOpts = JSON.parse( SLACK_NOTIFICATION );
      var fields = [{ title : "Fleet Unit", value : unit, short : false }];
      if(appendFields){
        fields = fields.concat(appendFields);
      }
      request.post(
        slackOpts.URL,
        {
          form : {
            payload : JSON.stringify({
              channel : slackOpts.CHANNEL,
              username : slackOpts.PRODUCT + " "+slackOpts.RELEASE_CHANNEL+" Docker Auto-Deploy",
              attachments :
                [
                {
                  fallback : message || "Deployment to " + unit + " : " + status,
                  color : color,
                  title : slackOpts.PRODUCT + " [" + slackOpts.RELEASE_CHANNEL + "] deployment " + status,
                  title_link : "https://hub.docker.com/r" + REPO_NAME + "/builds/",
                  text : message,
                  fields : fields
                }
              ]
            })
          }
        },
        function (error, response, body) {
          if (!error && response.statusCode == 200) {
            process.stdout.write( 'Slack Notification : success\n' );
          }else{
            process.stderr.write( 'Slack Notification : failed\n'+error );
          }
        }
      );
    } else {
      console.log(`Would send slack notification: ${message} : ${unit.unit} : ${status}`);
    }
  }
};

