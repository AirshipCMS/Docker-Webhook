var webhook = require('docker-webhook');
var Promise = require('bluebird');
var URL = require('url');
var exec = require('child_process').exec;

function promiseFromExec(child){
  return new Promise(function(resolve, reject){
    child.stderr.pipe(process.stderr);
    child.stdout.pipe(process.stdout);
    child.addListener('error', function(err){
      reject(err.message);
    });
    child.addListener('exit', function(code,signal){
      if(code === 0){
        resolve(code);
      }else{
        reject(code);
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
          return promiseFromExec(
            exec('/bin/fleetctl --endpoint http://'+process.env.FLEETCTL_ENDPOINT+' ssh '+unit+' sudo systemctl restart '+unit)
          ).then(function(result){
            process.stdout.write('Upgrade complete with exit code: ' + result);
          },function(err){
            process.stderr.write('Upgrade error: ' + err);
          });
        }, { concurrency : 1 })
      );

    }else{
      process.stderr.write('got bad payload?, did nothing \n' + url + '\n' + json);
    }
  }else{
    process.stderr.write('got request, did nothing \n' + url + '\n' + json);
  }
});
