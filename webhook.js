var webhook = require('docker-webhook');
var Promise = require('bluebird');
var URL = require('url');
var exec = require('child_process').exec;
var request = require('request');

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

webhook(function cb(json, url) {
  var url_auth_token = URL.parse(url).path.substr(1);
  if( url_auth_token === process.env.AUTH_TOKEN ){
    // authorized to run hook commands
    if( json.hasOwnProperty('repository') && json.repository.repo_name === process.env.REPO_NAME ){

      Promise.all(
        JSON.parse( process.env.UPDATE_UNITS )
        .map(function(unit){
          // each unit runs 2 commands, stop then start
          return promiseFromExec(
            exec('/bin/fleetctl --endpoint http://'+process.env.FLEETCTL_ENDPOINT+' stop '+unit), unit
          ).then(function(result){
            process.stdout.write('Upgrade-> STOPPED unit '+ result.unit +' with exit code: ' + result.message + '\n');
            return promiseFromExec(
              exec('/bin/fleetctl --endpoint http://'+process.env.FLEETCTL_ENDPOINT+' start '+result.unit), result.unit
            );
          }).then(function(result){
            process.stdout.write('Upgrade-> STARTED stopped unit, completed with exit code: ' + result.message + '\n');
            slack.success( result );
          },function(err){
            process.stderr.write('Upgrade-> error: ' + err.message + '\n\n');
            slack.fail( err );
          });
        }, { concurrency : 1 })
      );

    }else{

      process.stderr.write(
        slack.error( 'got bad payload?, did nothing \n' + url + '\n' + json + '\n')
      );
    }
  }else{

    process.stderr.write(
      slack.error( 'got request, did nothing \n' + url + '\n' + json + '\n' )
    );
  }
});

var slack = {
  status : {
    SUCCESS : "success",
    FAIL : "failed",
    ERROR : "error"
  },
  success : function( result ){
    slack.notify( slack.status.SUCCESS, result.unit );
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
            process.stderr.write( 'Slack Notification : failed\n' );
          }
        }
      );
    }
  }
};

