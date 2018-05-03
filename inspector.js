'use strict';
const dateFormat = require('dateformat');
const Koa = require('koa');
const route = require('koa-route');
const websockify = require('koa-websocket');
const ivm = require('isolated-vm');

// Check to see if this is `runner.js`
let endpoint;
for (let ii = 0; ii < process.argv.length; ++ii) {
	let match = /\/([a-z]+\.js$)/.exec(process.argv[ii]);
	if (match) {
		endpoint = match[1];
		break;
	}
}

// Start inspector endpoint
let playerSandboxes = new Map;
function listen() {
	let app = websockify(new Koa);
	app.use(route.get('/', function(ctx) {
		ctx.body = `<!doctype html>
<head>
	<title>isolated-vm inspector list</title>
</head>
<body>
	<p>I can't hyperlink to the chrome devtools so you have to click the textbox, copy it, and paste into a new window.</p>
	<table>
		<tr>
			<th>User</th>
			<th>Created</th>
			<th>isolate.cpuTime</th>
			<th>Inspector</th>
		</tr>
${function() {
	let rows = [];
	for (let pair of playerSandboxes) {
		let uri = `chrome-devtools://devtools/bundled/inspector.html?experiments=true&v8only=true&ws=127.0.0.1:7777/inspect/${pair[0]}`;
		let cpuTime = pair[1].getIsolate().cpuTime;
		rows.push(`<tr>
			<td>${pair[0]}</td>
			<td>${dateFormat(pair[1]._created, 'hh:MM.sstt')}</td>
			<td>${cpuTime[0] * 1e3 + cpuTime[1] / 1e6}ms</td>
			<td><input type="text" readonly value="${uri}" onclick="this.select()" width=100 /></td>
		</tr>`);
	}
	return rows.join('');
}()}
</table></html>
		`;
	}));
	app.ws.use(async function(ctx, next) {
		try {
			await next();
		} catch (err) {
			console.error('inspector error', err);
			ctx.websocket.close();
		}
	});
	app.ws.use(route.all('/inspect/:userId', async function(ctx) {
		let userId = /\/inspect\/(.+)/.exec(ctx.req.url)[1]; // koa-route is broken?
		let sandbox = playerSandboxes.get(userId);
		let ws = ctx.websocket;
		if (sandbox === undefined) {
			ctx.websocket.close();
			return;
		}
		// Setup inspector session
		let channel = sandbox.getIsolate().createInspectorSession();
		function dispose() {
			try {
				channel.dispose();
			} catch (err) {}
		}
		ws.on('error', dispose);
		ws.on('close', dispose);

		// Relay messages from frontend to backend
		ws.on('message', function(message) {
			try {
				channel.dispatchProtocolMessage(message);
			} catch (err) {
				// This happens if inspector session was closed unexpectedly
				dispose();
				ws.close();
			}
		});

		// Relay messages from backend to frontend
		function send(message) {
			try {
				ws.send(message);
			} catch (err) {
				dispose();
			}
		}
		channel.onResponse = (callId, message) => send(message);
		channel.onNotification = send;
	}));
	app.ws.use(function(ctx){ 
		ctx.websocket.close();
	});
	app.listen(7777);
}

// Include `print` function in every isolate which goes to main nodejs output
ivm.Isolate.prototype.createContext = function(createContext) {
	return async function(...args) {
		let context = await createContext.apply(this, args);
		await context.global.set('print', new ivm.Reference((...args) => console.log(...args)));
		await (await this.compileScript('print = (print => (...args) => print.applySync(null, args.map(str => "" + str)))(print)')).run(context);
		return context;
	};
}(ivm.Isolate.prototype.createContext);

// Screeps mod
module.exports = function(config) {
	if (!config.engine) {
		return;
	}
	config.engine.enableInspector = true;
	config.engine.mainLoopResetInterval = 0x7fffffff;
	if (endpoint === 'runner.js') {
		listen();
		config.engine.on('playerSandbox', function(sandbox, userId) {
			let current = playerSandboxes.get(userId);
			if (current !== undefined && current.getIsolate() === sandbox.getIsolate()) {
				sandbox._created = current._created;
			} else {
				sandbox._created = Date.now();
			}
			playerSandboxes.set(userId, sandbox);
		});
	}
};
