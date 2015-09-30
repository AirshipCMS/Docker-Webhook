var webhook = require('docker-webhook');
var Promise = require('bluebird');
var URL = require('url');
var exec = require('child_process').exec;

function promiseFromExec(child){
  return new Promise(function(resolve, reject){
    child.addListener('error', reject);
    child.addListener('exit', resolve);
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
            process.stdout.write(result);
          },function(err){
            process.stderr.write(err);
          });
        })
      )
      .then(function(results){
        process.stdout.write(results.length + ' results completed.');
      });

    }else{
      process.stderr.write('got bad payload?, did nothing \n' + url + '\n' + json);
    }
  }else{
    process.stderr.write('got request, did nothing \n' + url + '\n' + json);
  }
});
