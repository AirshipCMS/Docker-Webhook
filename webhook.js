var webhook = require('docker-webhook');
var URL = require('url');
var exec = require('child_process').exec;

webhook(function cb(json, url) {
  var url_auth_token = URL.parse(url).path.substr(1);
  if( url_auth_token === process.env.AUTH_TOKEN ){
    // authorized to run hook commands
    if( json.hasOwnProperty('repository') && json.repository.repo_name === 'airshipcms/docker-airship' ){
      exec('/bin/fleetctl --endpoint http://'+process.env.FLEETCTL_ENDPOINT+' ssh airship@'+process.env.AIRSHIP_IDX+' sudo systemctl restart airship@'+process.env.AIRSHIP_IDX, function (error, stdout, stderr) {
        if(stderr) process.stdout.write(stderr);
        process.stdout.write(stdout);
      });
    }else{
      process.stdout.write('got bad payload?, did nothing \n' + url + '\n' + json);
    }
  }else{
    process.stdout.write('got request, did nothing \n' + url + '\n' + json);
  }
});
