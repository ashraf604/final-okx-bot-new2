modules = ["nodejs-20"]
run = "npm run start"

[nix]
channel = "stable-25_05"

[deployment]
run = ["sh", "-c", "npm run start"]

[workflows]
runButton = "Start Bot"

[[workflows.workflow]]
name = "Start Bot"
author = 46157092
mode = "sequential"

[[workflows.workflow.tasks]]
task = "shell.exec"
args = "node index.js"
