var webhook = require('docker-webhook');
var Promise = require('bluebird');
var URL = require('url');
var exec = require('child_process').exec;
var request = require('request');
var INACTIVE_TIMEOUT = 600000; // ms, 10 mins
var VERSION_ENDPOINT = '/_version';

function etcdPathToFleetUnit(path){
  return s.replace("/airship/app/","airship@").replace("/airship/nginx/http/","nginx@");
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

function promiseOutputFromExec(child, unit){
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
        resolve({ output : data, unit : unit});
      }else{
        reject({ output : data, unit : unit});
      }
    });
  });
}

function getVersionAndNotify( result ) {
  promiseOutputFromExec(
    exec("/bin/fleetctl --endpoint "+process.env.FLEETCTL_ENDPOINT+" list-units | grep '"+result.unit+"' | awk '{print $2}'"), result.unit
  ).then(function(result){
    var port = null;
    // static port => 808%i, api port => 389%i
    if(result.unit.indexOf('nginx') >= 0){
      port = "808"+(result.unit.split('@').pop());
    }else{
      port = "389"+(result.unit.split('@').pop());
    }
    var unit_url = "http://"+result.output.split('/')[1]+':'+port+VERSION_ENDPOINT;
    request.get(
      {
        url : unit_url,
        json : true
      },
      function (error, response, body) {
        if (!error && response.statusCode == 200) {
          var versions = {};
          if(process.env.REPORT_VERSION === "api"){
            versions.API_VERSION_CODE = body.API_VERSION_CODE;
            versions.API_VERSION_TAG = body.API_VERSION_TAG;
          }else{ // "static"
            versions.VERSION_CODE = body.VERSION_CODE;
            versions.VERSION_TAG = body.VERSION_TAG;
          }
          slack.success( result.unit, versions );
          process.stdout.write( 'Updated Version : '+JSON.stringify(versions)+'\n' );
        }else{
          slack.error( "Failed to get updated version : "+result.unit );
          process.stderr.write( 'Get Updated Version : failed\n'+error );
        }
      }
    );
  },function(err){
    process.stderr.write('GetVersion-> error: ' + err.message + '\n\n');
    slack.fail( err );
  });
}

/*
 * recursively unshift each unit in [units] until none left
 */
function incrementallyUpdateUnits( units ) {
  if(units.length > 0){
    var unit = units.shift();
    // each unit runs 2 commands, stop then start
    return promiseFromExec(
      exec('/bin/fleetctl --endpoint '+process.env.FLEETCTL_ENDPOINT+' stop '+unit+' && sleep 10'), unit
    ).then(function(result){
      process.stdout.write('Upgrade-> STOPPED unit '+ result.unit +' with exit code: ' + result.message + '\n');
      return promiseFromExec(
        exec('/bin/fleetctl --endpoint '+process.env.FLEETCTL_ENDPOINT+' start '+result.unit), result.unit
      );
    }).then(function(result){
      process.stdout.write('Upgrade-> STARTED stopped unit, completed with exit code: ' + result.message + '\n');
      process.stdout.write('waiting for update: ' + result.message + '\n');

      var start = Date.now();
      var now = start;
      var active = false;
      var checker = setInterval(function(){
        now = Date.now();
        if( now - start < INACTIVE_TIMEOUT ){
          if( !active ){
            promiseOutputFromExec(
              exec("/bin/fleetctl --endpoint "+process.env.FLEETCTL_ENDPOINT+" list-units | grep '"+result.unit+"' | awk '{print $3}'"), result.unit
            ).then(function(statusResult){
              if(statusResult.output === "active"){
                active = true;
                getVersionAndNotify( result );
                clearInterval(checker);
                incrementallyUpdateUnits(units);
              }
            },function(err){
              process.stderr.write('Upgrade-> error: ' + err.message + '\n\n');
              slack.fail( err );
              clearInterval(checker);
            });
          }
        }else{
          process.stderr.write('Upgrade-> timeout error: unit ' + result.unit + ' never became active\n\n');
          clearInterval(checker);
          incrementallyUpdateUnits(units);
        }
      }, 1000);
    },function(err){
      process.stderr.write('Upgrade-> error: ' + err.message + '\n\n');
      slack.fail( err );
      incrementallyUpdateUnits(units);
    });
  }
}

webhook(function cb(json, url) {
  var url_auth_token = URL.parse(url).path.substr(1);
  if( url_auth_token === process.env.AUTH_TOKEN ){
    // authorized to run hook commands
    if( json.hasOwnProperty('repository') &&
        json.repository.hasOwnProperty('repo_name') &&
        json.hasOwnProperty('push_data') &&
        json.push_data.hasOwnProperty('tag') &&
        json.repository.repo_name === process.env.REPO_NAME &&
        json.push_data.tag === process.env.TAG
      ){

      incrementallyUpdateUnits(JSON.parse( require('./units') ).slice(1).map(etcdPathToFleetUnit));

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
  success : function( unit, version ){
    slack.notify( slack.status.SUCCESS, unit, version );
  },
  fail : function( result ){
    slack.notify( slack.status.FAIL, result.unit );
  },
  error : function( message ){
    slack.notify( slack.status.ERROR, null, message );
    return message;
  },
  notify : function( status, unit, message ){

    if( process.env.SLACK_NOTIFICATION !== undefined ){
      var color = status === "success" ? "good" : "danger";
      var slackOpts = JSON.parse( process.env.SLACK_NOTIFICATION );
      request.post(
        slackOpts.URL,
        {
          form : {
            payload : JSON.stringify({
              channel : slackOpts.CHANNEL,
              username : slackOpts.PRODUCT + " "+slackOpts.RELEASE_CHANNEL+" Docker Auto-Deploy Webhook",
              attachments :
                [
                {
                  fallback : message || "Deployment to " + unit + " : " + status,
                  color : color,
                  title : slackOpts.PRODUCT + " [" + slackOpts.RELEASE_CHANNEL + "] deployment " + status,
                  title_link : "https://hub.docker.com/r" + process.env.REPO_NAME + "/builds/",
                  text : message,
                  fields :
                    [
                    /*{
                      title : "Version",
                      value : "v.xxx",
                      short : true
                      },*/
                    {
                      title : "Fleet Unit",
                      value : unit,
                      short : true
                    }
                  ]
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
    }
  }
};

