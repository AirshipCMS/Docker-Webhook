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
  AUTH_TOKEN,
  SLACK_NOTIFICATION,
  REPO_NAME,
  TAG,
  UNITS_CONFIG_PATH = '/srv/units.json',
} = process.env;

function incrementallyUpdateUnits( units ){
  console.log(units);
}

function etcdPathToFleetUnit(path){
  return path.replace("/airship/drone/","drone@").replace("/airship/app/","airship@").replace("/airship/nginx/http/","nginx@");
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

        try{
          var unitsJson = JSON.parse( fs.readFileSync(UNITS_CONFIG_PATH) );
          incrementallyUpdateUnits( unitsJson.slice(1).map(etcdPathToFleetUnit) );

        }catch(e){
          process.stderr.write(
            `failed to read and parse ${UNITS_CONFIG}\n`
          );
        }

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

