// Explicit operator action only. Never invoked during deployment or Worker startup.
const { BOT_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!BOT_TOKEN || !/^\d{1,20}$/.test(CLIENT_ID ?? "") || !/^\d{1,20}$/.test(GUILD_ID ?? "")) throw new Error("Set BOT_TOKEN, CLIENT_ID, and GUILD_ID before registering commands.");
const string = (name, description, extra = {}) => ({ type:3,name,description,...extra });
const marketOption = string("market","Select market",{required:true,autocomplete:true});
const sub = (name,description,options = []) => ({type:1,name,description,options});
const commands = [
 {name:"balance",description:"Check reaction currency",options:[{type:6,name:"user",description:"User to check"}]},
 {name:"leaderboard",description:"View top reaction currency earners"},
 {name:"backfill",description:"Queue a bounded reaction history scan",default_member_permissions:"8",options:[{type:4,name:"limit",description:"Messages per channel (100-1000)",min_value:100,max_value:1000},{type:5,name:"reset",description:"Restart scan progress (awards remain deduplicated)"}]},
 {name:"market",description:"Create and manage prediction markets",options:[
  {type:2,name:"create",description:"Create prediction market",options:[sub("binary","Create Yes/No market"),sub("multi","Create multiple choice market")]},
  sub("list","List markets",[string("status","Filter status",{choices:[{name:"All",value:"all"},{name:"Open",value:"open"},{name:"Resolved",value:"resolved"}]})]),
  sub("view","View market and order book",[marketOption]),sub("resolve","Resolve a market you are oracle for",[marketOption]),sub("cancel","Cancel your active order",[marketOption]),sub("positions","View positions and orders"),
  sub("order","Place a limit order",[marketOption,string("outcome","Select outcome",{required:true,autocomplete:true}),string("direction","Buy or sell",{required:true,choices:[{name:"Buy",value:"buy"},{name:"Sell",value:"sell"}]}),{type:4,name:"quantity",description:"Contracts",required:true,min_value:1,max_value:1000},{type:10,name:"price",description:"Price (two decimals)",required:true,min_value:0.01,max_value:0.99}])
 ]}
].map(command=>({...command,contexts:[0],integration_types:[0]}));
const response = await fetch(`https://discord.com/api/v10/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`,{method:"PUT",headers:{Authorization:`Bot ${BOT_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify(commands)});
if (!response.ok) throw new Error(`Command registration failed: HTTP ${response.status}`);
console.log(`Registered ${commands.length} guild commands.`);
