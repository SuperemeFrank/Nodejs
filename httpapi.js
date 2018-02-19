s = require('express');
var app = express();
var bodyParser = require('body-parser');
var mysql = require('mysql');
var http = require('http');
var https = require('https');
var time_out = 3000;
const REMOTE_PATH_LWA = "https://api.amazon.com/user/profile?access_token=";
app.use(bodyParser.json({
    limit: '1mb'
}));
app.use(bodyParser.urlencoded({
    extended: false
}));
var judgeReq = function(reqBody) { //判断请求格式函数
    if (reqBody.messageId && reqBody.source && reqBody.name && reqBody.namespace && reqBody.payloadVersion && reqBody.profileType && reqBody.token) {
        return true;
    }
    return false;
}
var judgeControl = function(reqBody) { //判断控制指令请求
    if (reqBody.name == "TurnOn" || reqBody.name == "TurnOff" || reqBody.name == "SetPercentage") {
        return 1;
    } else { //这里为以后拓展保留判断
        return 2;
    }
}
var errorRes = function(reqBody, res, errorType) { //出现问题调用的返回错误信息函数
    if (reqBody.namespace == "Control") {
        var redisData = { //如果没有对应AmazonID 的userID，dis返回
            "messageId": reqBody.messageId,
            "source": reqBody.source,
            "name": reqBody.name,
            "namespace": reqBody.namespace,
            "payloadVersion": reqBody.payloadVersion,
            "feedback": "Error",
            "errorType": errorType
        };
        res.send(JSON.stringify(redisData));
        res.end();
    } else if (reqBody.namespace == "Alexa.Discovery") { //无对应的时候，control 返回
        var resdisData = {
            "messageId": reqBody.messageId,
            "source": reqBody.source,
            "name": reqBody.name,
            "namespace": reqBody.namespace,
            "payloadVersion": reqBody.payloadVersion,
            "discoveredAppliances": []
        };
        res.send(JSON.stringify(resdisData));
        res.end();
    }

}
var createPayload = function(reqBody, userId) { //构建payload信息
    var payload = "";
    if (judgeControl(reqBody) == "1") {
        payload = payload + "0023"; //命令类型
    } else { //保留拓展的控制指令判断
        return;
    }
    payload = payload + "00000003"; //来源（http)
    var userLen = userId.length.toString(16); //用户名长度 ************这里暂用发来的用户名
    while (userLen.length < 8) {
        userLen = "0" + userLen;
    }
    payload = payload + userLen;
    payload = payload + userId; //***********暂用发来的用户名
    var myDate = new Date();
    var date = myDate.toLocaleString();
    var dateLen = "000000" + date.length.toString(16);
    payload = payload + dateLen;
    payload = payload + date;
    var value = "";
    if (reqBody.value == "") {
        console.log('body.value is null');
        if (reqBody.name == "TurnOn") {
            value = (100).toString(16);
        }
        if (reqBody.name == "TurnOff") {
            value = (0).toString(16);
        }
    } else {
        value = parseInt(reqBody.value).toString(16);
    }
    while (value.length < 2) {
        value = "0" + value;
    }
    payload = payload + value;
    return payload;

}
var conn = mysql.createConnection({
    host: '202.11.4.63',
    user: 'zhangqian',
    password: 'zhangqian',
    database: 'Stellar'

});
conn.connect(function(err) {
    if (err) {
        console.log('error connecting:' + err);
        return;
    }
    console.log('The database is connected');
});
//监听post请求
app.post('/', function(req, res) {
    console.log('The req.body is :' + JSON.stringify(req.body));
    if (judgeReq(req.body)) { //验证请求的格式合法
        var reqUrl = REMOTE_PATH_LWA + req.body.token;
        var AmazonId = "";
        var userId = "";
        var getAId = https.get(reqUrl, function(respond) { //通过token 获取AmazonID
            respond.on('data', (chunk) => {
                AmazonId += chunk;
                var AmzId = JSON.parse(AmazonId);
                if (AmzId.user_id) { //判断token有效
                    console.log('the AmazonId is' + AmzId.user_id);
                    conn.query('select UserID from Users where AmazonID=?', AmzId.user_id, function(err, rows, fields) {
                        if (err) throw err;
                        if (rows.length == 0) { // 不能通过Amazonid查到userId
                            console.log('cannot find userId by AmazonId');
                            errorRes(req.body, res, "2");
                        } else { //能通过Amazonid查到userId
                            console.log('find userID by AmazonID');
                            userId = rows[0].UserID;
                            console.log('the userId is' + userId);
                            if (req.body.name != "Discover") {
                                console.log('Its a Control instruction '); //如果请求是控制指令
                                var redisData = { //构造Control返回
                                    "messageId": req.body.messageId,
                                    "source": req.body.source,
                                    "name": req.body.name,
                                    "namespace": req.body.namespace,
                                    "payloadVersion": req.body.payloadVersion,
                                    "feedback": "Error",
                                    "errorType": "1"
                                };
                                conn.query('select UserID from Lights where Addr=?', req.body.applianceId, function(err, rows, fields) { //userId-applianceId再验证
                                    if (err) throw err;
                                    if (rows.length) {
                                        console.log('Can find userId by applianceId');
                                        var verifUserId = rows[0].UserID;
                                        if (userId == verifUserId) {
                                            console.log('UserId-applianceId matched');
                                            var payload2 = createPayload(req.body, userId); //做验证的payload
                                            var payload = payload2 + "\0"; //发送的payload
                                            // console.log('the payload is ' + payload);
                                            var mqPost = { //构造发送POST请求body
                                                "properties": {},
                                                "routing_key": req.body.applianceId, //灯的MAC地址
                                                "payload": payload, //发送的控制信息
                                                "payload_encoding": "string"
                                            }
                                            var mqGet = { //构造验证POST请求body
                                                "count": 1,
                                                "requeue": true,
                                                "encoding": "auto",
                                                "truncate": 50000
                                            }
                                            var first_options = { //第一个队列请求options
                                                hostname: '172.16.40.116',
                                                port: '15672',
                                                path: '/api/exchanges/%2f/app_exchange/publish',
                                                method: 'POST',
                                                auth: 'hahaha:hahaha'
                                            };
                                            var second_options = { //第二个队列请求options
                                                hostname: '172.16.40.116',
                                                port: '15672',
                                                auth: 'hahaha:hahaha',
                                                path: '/api/queues/%2f/a_httpqueue/get?columns=payload',
                                                method: 'POST',
                                                headers: {
                                                    'Content-Type': 'application/json',
                                                    'Content-Length': JSON.stringify(mqGet).length
                                                }
                                            };
                                            var first_req = http.request(first_options, function(respond) { //向mq发送指令
                                                var first_res = "";
                                                respond.on('data', (chunk) => {
                                                    first_res += chunk;
                                                    console.log("the first respond is" + first_res);
                                                });
                                                var myInterval = setTimeout(function() { //3秒内每0.5秒获取一次mq消息
                                                    var second_req = http.request(second_options, function(respond) { //向mq取消息
                                                        var receive = "";
                                                        respond.setEncoding('utf8');
                                                        respond.on('data', (chunk) => {
                                                            receive += chunk;
                                                            console.log('the second respond is ' + receive);
                                                            var cfPayload = [{
                                                                "payload": payload2
                                                            }];
                                                            console.log("the cfPayload is" + JSON.stringify(cfPayload));
                                                            if (receive == JSON.stringify(cfPayload)) { //获取的消息匹配
                                                                console.log('payload matched');
                                                                redisData.feedback = "Confirm";
                                                                redisData.errorType = "0";
                                                                res.send(JSON.stringify(redisData));
                                                                res.end();
                                                            } else {
                                                                console.log('payload not matched');
                                                                res.send(JSON.stringify(redisData));
                                                                res.end();
                                                            }
                                                        });

                                                    });
                                                    second_req.setTimeout(3000, function() { //设置超时时间
                                                        console.log('time is out');
                                                        res.send(JSON.stringify(redisData));
                                                        res.end();
                                                    });
                                                    second_req.on('error', (e) => {
                                                        console.log("the error in second_req is" + e);
                                                    });
                                                    second_req.write(JSON.stringify(mqGet));
                                                    second_req.end();
                                                }, 1500);
                                            });
                                            first_req.setTimeout(3000, function() {
                                                console.log("the server is closed !");
                                            }); //向mq插入消息
                                            first_req.on('error', (e) => {
                                                console.log('the error in first_req is' + e);
                                            });
                                            first_req.write(JSON.stringify(mqPost));
                                            first_req.end();
                                        } else {
                                            console.log('UserId-applianceId not matched');
                                            errorRes(req.body, res, "4");
                                        }
                                    } else { //通过applianceId查询不到userid
                                        console.log('Can not find userId by applianceId');
                                        errorRes(req.body, res, "3");
                                    }
                                });
                            } else { //如果请求是discover指令
                                var resdisData = {
                                    "messageId": req.body.messageId,
                                    "source": req.body.source,
                                    "name": req.body.name,
                                    "namespace": req.body.namespace,
                                    "payloadVersion": req.body.payloadVersion,
                                    "discoveredAppliances": []
                                };

                                conn.query('select Addr,Name,SoftVersion from Lights where UserID=?', userId, function(err, rows, fields) { //********暂用发来的用户名
                                    if (err) throw err;
                                    for (var i in rows) { //构造discover返回值
                                        var disApp = { //v1.0 只有设备id,name,version 可以读出
                                            "applianceId": rows[i].Addr,
                                            "friendlyDescription": "Wi-Fi color bulb",
                                            "friendlyName": rows[i].Name,
                                            "isReachable": true,
                                            "manufacturerName": "SansiTech",
                                            "modelName": "Stellar Wi-Fi Color Bulb",
                                            "version": rows[i].SoftVersion,
                                            "actions": [
                                                "setPercentage",
                                                "turnOn",
                                                "turnOff"
                                            ],
                                            "additionalApplianceDetails": {}
                                        };
                                        resdisData.discoveredAppliances.push(disApp);
                                    }
                                    // console.log('the disData is ' + JSON.stringify(resdisData));
                                    res.send(resdisData);
                                    res.end();
                                    // conn.end();
                                });
                            }
                        }

                    });
                } else { //token 查不到Amazonid
                    console.log('the amazon token was wrong !');
                    errorRes(req.body, res, "5");
                }
            });
        });
    }
});
app.listen(7000);
console.log('server start at http://%s：%s/sendEmail/');
//errorType 0:操作成功 1:其他错误 2:AmazonId-userId无匹配 3：通过applianceId 不能查询到userId 4:userId与applianceId查到的userId不匹配 5:token错误
//每个Amazon账户只能绑定一个UserId
//每个appliance绑定一个userId