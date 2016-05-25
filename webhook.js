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
const {
  TEST = false,
  AUTH_TOKEN,
  FLEETCTL_ENDPOINT,
  SLACK_NOTIFICATION,
  REPO_NAME,
  TAG,
  UNITS_CONFIG_PATH = '/srv/units.json',
} = process.env;
const FLEETCTL_CMD = `/bin/fleetctl --endpoint ${FLEETCTL_ENDPOINT}`;
const queue = [];
let is_updating = false;

function fleetctl( cmd ){
  return exec(
    TEST ?
      `/bin/echo fleetctl ${cmd}` :
      `${FLEETCTL_CMD} ${cmd}`
  );
}

function promiseFromExec(child, unit){
  return new Promise(function(resolve, reject){
    child.stderr.pipe(process.stderr);
    child.stdout.pipe(process.stdout);
    child.addListener('error', function(err){
      reject({ message : err.message, unit : unit});
    });
    child.addListener('exit', function(code,signal){
      if(code === 0){
        resolve({ message : code, unit : unit});
      }else{
        reject({ message : code, unit : unit});
      }
    });
  });
}

function etcdPathToFleetUnit(path){
  return path.replace("/airship/drone/","drone@").replace("/airship/app/","airship@").replace("/airship/nginx/http/","nginx@");
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
      fleetctl(`stop ${unit} && sleep 10`), unit
    ).then(function(result){
      process.stdout.write('Upgrade-> STOPPED unit '+ result.unit +' with exit code: ' + result.message + '\n');
      return promiseFromExec(
        fleetctl(`start ${result.unit}`), result.unit
      );
    }).then(function(result){
      process.stdout.write('Upgrade-> STARTED stopped unit, completed with exit code: ' + result.message + '\n');
      process.stdout.write('waiting for update: ' + result.message + '\n');




      setTimeout(()=> {
        if(queue.length > 0){
          process.stdout.write(`Update chain interrupted, ${queue.length} new requests in queue, starting over.\n`);
          performUpdate();
        } else {
          process.stdout.write(`Update chain continuing.\n`);
          unitUpdated(units);
        }
      }, 1000);

    },function(err){
      process.stderr.write('Upgrade-> error: ' + err.message + '\n\n');
      slack.fail( err );
      unitUpdated(units);
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
    incrementallyUpdateUnits( unitsJson.filter(u => u !== null).map(etcdPathToFleetUnit) );
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
      console.log(`Would send slack notification: ${message} : ${unit} : ${status}`);
    }
  }
};

