// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { assign, CommentArray, CommentJSONValue, CommentObject, parse } from "comment-json";
import { DebugMigrationContext } from "./debugMigrationContext";
import {
  defaultNpmInstallArg,
  FolderName,
  Prerequisite,
  TaskCommand,
  TaskDefaultValue,
  TaskLabel,
} from "../../../../common/local";
import {
  createResourcesTask,
  generateLabel,
  isCommentArray,
  isCommentObject,
  OldProjectSettingsHelper,
  saveRunScript,
  setUpLocalProjectsTask,
  startAuthTask,
  startBackendTask,
  startBotTask,
  startFrontendTask,
  updateLocalEnv,
  watchBackendTask,
} from "./debugV3MigrationUtils";
import { InstallToolArgs } from "../../../../component/driver/prerequisite/interfaces/InstallToolArgs";
import { BuildArgs } from "../../../../component/driver/interface/buildAndDeployArgs";
import { LocalCrypto } from "../../../crypto";
import * as util from "util";

export async function migrateTransparentPrerequisite(
  context: DebugMigrationContext
): Promise<void> {
  for (const task of context.tasks) {
    if (
      !isCommentObject(task) ||
      !(task["type"] === "teamsfx") ||
      !(task["command"] === TaskCommand.checkPrerequisites)
    ) {
      continue;
    }

    if (isCommentObject(task["args"]) && isCommentArray(task["args"]["prerequisites"])) {
      const newPrerequisites: string[] = [];
      const toolsArgs: InstallToolArgs = {};

      for (const prerequisite of task["args"]["prerequisites"]) {
        if (prerequisite === Prerequisite.nodejs) {
          newPrerequisites.push(`"${Prerequisite.nodejs}", // Validate if Node.js is installed.`);
        } else if (prerequisite === Prerequisite.m365Account) {
          newPrerequisites.push(
            `"${Prerequisite.m365Account}", // Sign-in prompt for Microsoft 365 account, then validate if the account enables the sideloading permission.`
          );
        } else if (prerequisite === Prerequisite.portOccupancy) {
          newPrerequisites.push(
            `"${Prerequisite.portOccupancy}", // Validate available ports to ensure those debug ones are not occupied.`
          );
        } else if (prerequisite === Prerequisite.func) {
          toolsArgs.func = true;
        } else if (prerequisite === Prerequisite.devCert) {
          toolsArgs.devCert = { trust: true };
        } else if (prerequisite === Prerequisite.dotnet) {
          toolsArgs.dotnet = true;
        }
      }

      task["args"]["prerequisites"] = parse(`[
        ${newPrerequisites.join("\n  ")}
      ]`);
      if (Object.keys(toolsArgs).length > 0) {
        if (!context.appYmlConfig.deploy) {
          context.appYmlConfig.deploy = {};
        }
        context.appYmlConfig.deploy.tools = toolsArgs;
      }
    }
  }
}

export async function migrateTransparentLocalTunnel(context: DebugMigrationContext): Promise<void> {
  for (const task of context.tasks) {
    if (
      !isCommentObject(task) ||
      !(task["type"] === "teamsfx") ||
      !(task["command"] === TaskCommand.startLocalTunnel)
    ) {
      continue;
    }

    if (isCommentObject(task["args"])) {
      const comment = `
        {
          // Keep consistency with migrated configuration.
        }
      `;
      task["args"]["env"] = "local";
      task["args"]["output"] = assign(parse(comment), {
        endpoint: context.placeholderMapping.botEndpoint,
        domain: context.placeholderMapping.botDomain,
      });
    }
  }
}

export async function migrateTransparentNpmInstall(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      !isCommentObject(task) ||
      !(task["type"] === "teamsfx") ||
      !(task["command"] === TaskCommand.npmInstall)
    ) {
      ++index;
      continue;
    }

    if (isCommentObject(task["args"]) && isCommentArray(task["args"]["projects"])) {
      for (const npmArgs of task["args"]["projects"]) {
        if (!isCommentObject(npmArgs) || !(typeof npmArgs["cwd"] === "string")) {
          continue;
        }
        const npmInstallArg: BuildArgs = { args: "install" };
        npmInstallArg.workingDirectory = npmArgs["cwd"].replace("${workspaceFolder}", ".");

        if (typeof npmArgs["npmInstallArgs"] === "string") {
          npmInstallArg.args = `install ${npmArgs["npmInstallArgs"]}`;
        } else if (
          isCommentArray(npmArgs["npmInstallArgs"]) &&
          npmArgs["npmInstallArgs"].length > 0
        ) {
          npmInstallArg.args = `install ${npmArgs["npmInstallArgs"].join(" ")}`;
        }

        if (!context.appYmlConfig.deploy) {
          context.appYmlConfig.deploy = {};
        }
        if (!context.appYmlConfig.deploy.npmCommands) {
          context.appYmlConfig.deploy.npmCommands = [];
        }
        context.appYmlConfig.deploy.npmCommands.push(npmInstallArg);
      }
    }

    if (typeof task["label"] === "string") {
      // TODO: remove preLaunchTask in launch.json
      replaceInDependsOn(task["label"], context.tasks);
    }
    context.tasks.splice(index, 1);
  }
}

export async function migrateSetUpTab(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      !isCommentObject(task) ||
      !(task["type"] === "teamsfx") ||
      !(task["command"] === TaskCommand.setUpTab)
    ) {
      ++index;
      continue;
    }

    if (typeof task["label"] !== "string") {
      ++index;
      continue;
    }

    let url = new URL("https://localhost:53000");
    if (isCommentObject(task["args"]) && typeof task["args"]["baseUrl"] === "string") {
      try {
        url = new URL(task["args"]["baseUrl"]);
      } catch {}
    }

    if (!context.appYmlConfig.configureApp) {
      context.appYmlConfig.configureApp = {};
    }
    if (!context.appYmlConfig.configureApp.tab) {
      context.appYmlConfig.configureApp.tab = {};
    }
    context.appYmlConfig.configureApp.tab.domain = url.host;
    context.appYmlConfig.configureApp.tab.endpoint = url.origin;

    if (!context.appYmlConfig.deploy) {
      context.appYmlConfig.deploy = {};
    }
    if (!context.appYmlConfig.deploy.tab) {
      context.appYmlConfig.deploy.tab = {};
    }
    context.appYmlConfig.deploy.tab.port = parseInt(url.port);

    const label = task["label"];
    index = handleProvisionAndDeploy(context, index, label);
  }
}

export async function migrateSetUpBot(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      !isCommentObject(task) ||
      !(task["type"] === "teamsfx") ||
      !(task["command"] === TaskCommand.setUpBot)
    ) {
      ++index;
      continue;
    }

    if (typeof task["label"] !== "string") {
      ++index;
      continue;
    }

    if (!context.appYmlConfig.provision) {
      context.appYmlConfig.provision = {};
    }
    context.appYmlConfig.provision.bot = {
      messagingEndpoint: `$\{{${context.placeholderMapping.botEndpoint}}}/api/messages`,
    };

    if (!context.appYmlConfig.deploy) {
      context.appYmlConfig.deploy = {};
    }
    context.appYmlConfig.deploy.bot = true;

    const envs: { [key: string]: string } = {};
    if (isCommentObject(task["args"])) {
      if (task["args"]["botId"] && typeof task["args"]["botId"] === "string") {
        envs["BOT_ID"] = task["args"]["botId"];
      }
      if (task["args"]["botPassword"] && typeof task["args"]["botPassword"] === "string") {
        const envReferencePattern = /^\$\{env:(.*)\}$/;
        const matchResult = task["args"]["botPassword"].match(envReferencePattern);
        const botPassword = matchResult ? process.env[matchResult[1]] : task["args"]["botPassword"];
        if (botPassword) {
          const cryptoProvider = new LocalCrypto(context.oldProjectSettings.projectId);
          const result = cryptoProvider.encrypt(botPassword);
          if (result.isOk()) {
            envs["SECRET_BOT_PASSWORD"] = result.value;
          }
        }
      }
      if (
        task["args"]["botMessagingEndpoint"] &&
        typeof task["args"]["botMessagingEndpoint"] === "string"
      ) {
        if (task["args"]["botMessagingEndpoint"].startsWith("http")) {
          context.appYmlConfig.provision.bot.messagingEndpoint =
            task["args"]["botMessagingEndpoint"];
        } else if (task["args"]["botMessagingEndpoint"].startsWith("/")) {
          context.appYmlConfig.provision.bot.messagingEndpoint = `$\{{${context.placeholderMapping.botEndpoint}}}${task["args"]["botMessagingEndpoint"]}`;
        }
      }
    }
    await updateLocalEnv(context.migrationContext, envs);

    const label = task["label"];
    index = handleProvisionAndDeploy(context, index, label);
  }
}

export async function migrateSetUpSSO(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      !isCommentObject(task) ||
      !(task["type"] === "teamsfx") ||
      !(task["command"] === TaskCommand.setUpSSO)
    ) {
      ++index;
      continue;
    }

    if (typeof task["label"] !== "string") {
      ++index;
      continue;
    }

    if (!context.appYmlConfig.registerApp) {
      context.appYmlConfig.registerApp = {};
    }
    context.appYmlConfig.registerApp.aad = true;

    if (!context.appYmlConfig.configureApp) {
      context.appYmlConfig.configureApp = {};
    }
    context.appYmlConfig.configureApp.aad = true;

    if (!context.appYmlConfig.deploy) {
      context.appYmlConfig.deploy = {};
    }
    context.appYmlConfig.deploy.sso = true;

    const envs: { [key: string]: string } = {};
    if (isCommentObject(task["args"])) {
      if (task["args"]["objectId"] && typeof task["args"]["objectId"] === "string") {
        envs["AAD_APP_OBJECT_ID"] = task["args"]["objectId"];
      }
      if (task["args"]["clientId"] && typeof task["args"]["clientId"] === "string") {
        envs["AAD_APP_CLIENT_ID"] = task["args"]["clientId"];
      }
      if (task["args"]["clientSecret"] && typeof task["args"]["clientSecret"] === "string") {
        const envReferencePattern = /^\$\{env:(.*)\}$/;
        const matchResult = task["args"]["clientSecret"].match(envReferencePattern);
        const clientSecret = matchResult
          ? process.env[matchResult[1]]
          : task["args"]["clientSecret"];
        if (clientSecret) {
          const cryptoProvider = new LocalCrypto(context.oldProjectSettings.projectId);
          const result = cryptoProvider.encrypt(clientSecret);
          if (result.isOk()) {
            envs["SECRET_AAD_APP_CLIENT_SECRET"] = result.value;
          }
        }
      }
      if (
        task["args"]["accessAsUserScopeId"] &&
        typeof task["args"]["accessAsUserScopeId"] === "string"
      ) {
        envs["AAD_APP_ACCESS_AS_USER_PERMISSION_ID"] = task["args"]["accessAsUserScopeId"];
      }
    }
    await updateLocalEnv(context.migrationContext, envs);

    const label = task["label"];
    index = handleProvisionAndDeploy(context, index, label);
  }
}

export async function migratePrepareManifest(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      !isCommentObject(task) ||
      !(task["type"] === "teamsfx") ||
      !(task["command"] === TaskCommand.prepareManifest)
    ) {
      ++index;
      continue;
    }

    if (typeof task["label"] !== "string") {
      ++index;
      continue;
    }

    let appPackagePath: string | undefined = undefined;
    if (isCommentObject(task["args"]) && typeof task["args"]["appPackagePath"] === "string") {
      appPackagePath = task["args"]["appPackagePath"];
    }

    if (!appPackagePath) {
      if (!context.appYmlConfig.registerApp) {
        context.appYmlConfig.registerApp = {};
      }
      context.appYmlConfig.registerApp.teamsApp = true;
    }

    if (!context.appYmlConfig.configureApp) {
      context.appYmlConfig.configureApp = {};
    }
    if (!context.appYmlConfig.configureApp.teamsApp) {
      context.appYmlConfig.configureApp.teamsApp = {};
    }
    context.appYmlConfig.configureApp.teamsApp.appPackagePath = appPackagePath;

    const label = task["label"];
    index = handleProvisionAndDeploy(context, index, label);
  }
}

export async function migrateValidateDependencies(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      !isCommentObject(task) ||
      !(task["type"] === "shell") ||
      !(typeof task["command"] === "string") ||
      !task["command"].includes("${command:fx-extension.validate-dependencies}")
    ) {
      ++index;
      continue;
    }

    const newTask = generatePrerequisiteTask(task, context);

    context.tasks.splice(index, 1, newTask);
    ++index;

    const toolsArgs: InstallToolArgs = {};
    if (OldProjectSettingsHelper.includeTab(context.oldProjectSettings)) {
      toolsArgs.devCert = {
        trust: true,
      };
      if (OldProjectSettingsHelper.includeSSO(context.oldProjectSettings)) {
        toolsArgs.dotnet = true;
      }
    }
    if (OldProjectSettingsHelper.includeFunction(context.oldProjectSettings)) {
      toolsArgs.func = true;
      toolsArgs.dotnet = true;
    }
    if (Object.keys(toolsArgs).length > 0) {
      if (!context.appYmlConfig.deploy) {
        context.appYmlConfig.deploy = {};
      }
      context.appYmlConfig.deploy.tools = toolsArgs;
    }
  }
}

export async function migrateBackendExtensionsInstall(
  context: DebugMigrationContext
): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      !isCommentObject(task) ||
      !(task["type"] === "shell") ||
      !(
        typeof task["command"] === "string" &&
        task["command"].includes("${command:fx-extension.backend-extensions-install}")
      )
    ) {
      ++index;
      continue;
    }

    if (!context.appYmlConfig.deploy) {
      context.appYmlConfig.deploy = {};
    }
    context.appYmlConfig.deploy.dotnetCommand = {
      args: "build extensions.csproj -o ./bin --ignore-failed-sources",
      workingDirectory: `./${FolderName.Function}`,
      execPath: "${{DOTNET_PATH}}",
    };

    const label = task["label"];
    if (typeof label === "string") {
      replaceInDependsOn(label, context.tasks);
    }
    context.tasks.splice(index, 1);
  }
}

export async function migrateFrontendStart(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      isCommentObject(task) &&
      ((typeof task["dependsOn"] === "string" && task["dependsOn"] === "teamsfx: frontend start") ||
        (isCommentArray(task["dependsOn"]) &&
          task["dependsOn"].includes("teamsfx: frontend start")))
    ) {
      const newLabel = generateLabel("Start frontend", getLabels(context.tasks));
      const newTask = startFrontendTask(newLabel);
      context.tasks.splice(index + 1, 0, newTask);
      replaceInDependsOn("teamsfx: frontend start", context.tasks, newLabel);

      if (!context.appYmlConfig.deploy) {
        context.appYmlConfig.deploy = {};
      }
      if (!context.appYmlConfig.deploy.npmCommands) {
        context.appYmlConfig.deploy.npmCommands = [];
      }
      const existing = context.appYmlConfig.deploy.npmCommands.find(
        (value) => value.args === "install -D @microsoft/teamsfx-run-utils@alpha"
      );
      if (!existing) {
        context.appYmlConfig.deploy.npmCommands.push({
          args: "install -D @microsoft/teamsfx-run-utils@alpha",
          workingDirectory: ".",
        });
      }

      await saveRunScript(context.migrationContext, "run.tab.js", generateRunTabScript(context));

      break;
    } else {
      ++index;
    }
  }
}

export async function migrateAuthStart(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      isCommentObject(task) &&
      ((typeof task["dependsOn"] === "string" && task["dependsOn"] === "teamsfx: auth start") ||
        (isCommentArray(task["dependsOn"]) && task["dependsOn"].includes("teamsfx: auth start")))
    ) {
      const newLabel = generateLabel("Start auth", getLabels(context.tasks));
      const newTask = startAuthTask(newLabel);
      context.tasks.splice(index + 1, 0, newTask);
      replaceInDependsOn("teamsfx: auth start", context.tasks, newLabel);

      if (!context.appYmlConfig.deploy) {
        context.appYmlConfig.deploy = {};
      }
      if (!context.appYmlConfig.deploy.npmCommands) {
        context.appYmlConfig.deploy.npmCommands = [];
      }
      const existing = context.appYmlConfig.deploy.npmCommands.find(
        (value) => value.args === "install -D @microsoft/teamsfx-run-utils@alpha"
      );
      if (!existing) {
        context.appYmlConfig.deploy.npmCommands.push({
          args: "install -D @microsoft/teamsfx-run-utils@alpha",
          workingDirectory: ".",
        });
      }

      await saveRunScript(context.migrationContext, "run.auth.js", generateRunAuthScript(context));

      break;
    } else {
      ++index;
    }
  }
}

export async function migrateBotStart(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      isCommentObject(task) &&
      ((typeof task["dependsOn"] === "string" && task["dependsOn"] === "teamsfx: bot start") ||
        (isCommentArray(task["dependsOn"]) && task["dependsOn"].includes("teamsfx: bot start")))
    ) {
      const newLabel = generateLabel("Start bot", getLabels(context.tasks));
      const newTask = startBotTask(newLabel);
      context.tasks.splice(index + 1, 0, newTask);
      replaceInDependsOn("teamsfx: bot start", context.tasks, newLabel);

      if (!context.appYmlConfig.deploy) {
        context.appYmlConfig.deploy = {};
      }
      if (!context.appYmlConfig.deploy.npmCommands) {
        context.appYmlConfig.deploy.npmCommands = [];
      }
      const existing = context.appYmlConfig.deploy.npmCommands.find(
        (value) => value.args === "install -D @microsoft/teamsfx-run-utils@alpha"
      );
      if (!existing) {
        context.appYmlConfig.deploy.npmCommands.push({
          args: "install -D @microsoft/teamsfx-run-utils@alpha",
          workingDirectory: ".",
        });
      }

      await saveRunScript(context.migrationContext, "run.bot.js", generateRunBotScript(context));

      break;
    } else {
      ++index;
    }
  }
}

export async function migrateBackendWatch(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      isCommentObject(task) &&
      ((typeof task["dependsOn"] === "string" && task["dependsOn"] === "teamsfx: backend watch") ||
        (isCommentArray(task["dependsOn"]) && task["dependsOn"].includes("teamsfx: backend watch")))
    ) {
      const newLabel = generateLabel("Watch backend", getLabels(context.tasks));
      const newTask = watchBackendTask(newLabel);
      context.tasks.splice(index + 1, 0, newTask);
      replaceInDependsOn("teamsfx: backend watch", context.tasks, newLabel);

      break;
    } else {
      ++index;
    }
  }
}

export async function migrateBackendStart(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      isCommentObject(task) &&
      ((typeof task["dependsOn"] === "string" && task["dependsOn"] === "teamsfx: backend start") ||
        (isCommentArray(task["dependsOn"]) && task["dependsOn"].includes("teamsfx: backend start")))
    ) {
      const newLabel = generateLabel("Start backend", getLabels(context.tasks));
      const newTask = startBackendTask(newLabel);
      context.tasks.splice(index + 1, 0, newTask);
      replaceInDependsOn("teamsfx: backend start", context.tasks, newLabel);

      if (!context.appYmlConfig.deploy) {
        context.appYmlConfig.deploy = {};
      }
      if (!context.appYmlConfig.deploy.npmCommands) {
        context.appYmlConfig.deploy.npmCommands = [];
      }
      const existing = context.appYmlConfig.deploy.npmCommands.find(
        (value) => value.args === "install -D @microsoft/teamsfx-run-utils@alpha"
      );
      if (!existing) {
        context.appYmlConfig.deploy.npmCommands.push({
          args: "install -D @microsoft/teamsfx-run-utils@alpha",
          workingDirectory: ".",
        });
      }

      await saveRunScript(
        context.migrationContext,
        "run.api.js",
        generateRunBackendScript(context)
      );

      break;
    } else {
      ++index;
    }
  }
}

export async function migrateValidateLocalPrerequisites(
  context: DebugMigrationContext
): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      !isCommentObject(task) ||
      !(task["type"] === "shell") ||
      !(
        typeof task["command"] === "string" &&
        task["command"].includes("${command:fx-extension.validate-local-prerequisites}")
      )
    ) {
      ++index;
      continue;
    }

    const newTask = generatePrerequisiteTask(task, context);
    context.tasks.splice(index, 1, newTask);
    ++index;

    const toolsArgs: InstallToolArgs = {};
    const npmCommands: BuildArgs[] = [];
    let dotnetCommand: BuildArgs | undefined;
    if (OldProjectSettingsHelper.includeTab(context.oldProjectSettings)) {
      toolsArgs.devCert = {
        trust: true,
      };
      npmCommands.push({
        args: `install ${defaultNpmInstallArg}`,
        workingDirectory: `./${FolderName.Frontend}`,
      });
    }

    if (OldProjectSettingsHelper.includeFunction(context.oldProjectSettings)) {
      toolsArgs.func = true;
      toolsArgs.dotnet = true;
      npmCommands.push({
        args: `install ${defaultNpmInstallArg}`,
        workingDirectory: `./${FolderName.Function}`,
      });
      dotnetCommand = {
        args: "build extensions.csproj -o ./bin --ignore-failed-sources",
        workingDirectory: `./${FolderName.Function}`,
        execPath: "${{DOTNET_PATH}}",
      };
    }

    if (OldProjectSettingsHelper.includeBot(context.oldProjectSettings)) {
      if (OldProjectSettingsHelper.includeFuncHostedBot(context.oldProjectSettings)) {
        toolsArgs.func = true;
      }
      npmCommands.push({
        args: `install ${defaultNpmInstallArg}`,
        workingDirectory: `./${FolderName.Bot}`,
      });
    }

    if (Object.keys(toolsArgs).length > 0 || npmCommands.length > 0 || dotnetCommand) {
      if (!context.appYmlConfig.deploy) {
        context.appYmlConfig.deploy = {};
      }
      if (Object.keys(toolsArgs).length > 0) {
        context.appYmlConfig.deploy.tools = toolsArgs;
      }
      if (npmCommands.length > 0) {
        context.appYmlConfig.deploy.npmCommands = npmCommands;
      }
      context.appYmlConfig.deploy.dotnetCommand = dotnetCommand;
    }
  }
}

export async function migratePreDebugCheck(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      !isCommentObject(task) ||
      !(task["type"] === "shell") ||
      !(
        typeof task["command"] === "string" &&
        task["command"].includes("${command:fx-extension.pre-debug-check}")
      )
    ) {
      ++index;
      continue;
    }

    if (!context.appYmlConfig.registerApp) {
      context.appYmlConfig.registerApp = {};
    }
    if (OldProjectSettingsHelper.includeSSO(context.oldProjectSettings)) {
      context.appYmlConfig.registerApp.aad = true;
    }
    context.appYmlConfig.registerApp.teamsApp = true;

    if (OldProjectSettingsHelper.includeBot(context.oldProjectSettings)) {
      if (!context.appYmlConfig.provision) {
        context.appYmlConfig.provision = {};
      }
      context.appYmlConfig.provision.bot = {
        messagingEndpoint: `$\{{${context.placeholderMapping.botEndpoint}}}/api/messages`,
      };
    }

    if (!context.appYmlConfig.configureApp) {
      context.appYmlConfig.configureApp = {};
    }
    if (OldProjectSettingsHelper.includeTab(context.oldProjectSettings)) {
      context.appYmlConfig.configureApp.tab = {
        domain: "localhost:53000",
        endpoint: "https://localhost:53000",
      };
    }
    if (OldProjectSettingsHelper.includeSSO(context.oldProjectSettings)) {
      context.appYmlConfig.configureApp.aad = true;
    }
    if (!context.appYmlConfig.configureApp.teamsApp) {
      context.appYmlConfig.configureApp.teamsApp = {};
    }

    const validateLocalPrerequisitesTask = context.tasks.find(
      (_task) =>
        isCommentObject(_task) &&
        _task["type"] === "shell" &&
        typeof _task["command"] === "string" &&
        _task["command"].includes("${command:fx-extension.validate-local-prerequisites}")
    );
    if (validateLocalPrerequisitesTask) {
      if (!context.appYmlConfig.deploy) {
        context.appYmlConfig.deploy = {};
      }
      if (OldProjectSettingsHelper.includeTab(context.oldProjectSettings)) {
        context.appYmlConfig.deploy.tab = {
          port: 53000,
        };
      }
      if (OldProjectSettingsHelper.includeBot(context.oldProjectSettings)) {
        context.appYmlConfig.deploy.bot = true;
      }
      if (OldProjectSettingsHelper.includeSSO(context.oldProjectSettings)) {
        context.appYmlConfig.deploy.sso = true;
      }
    }

    const existingLabels = getLabels(context.tasks);
    const createResourcesLabel = generateLabel("Create resources", existingLabels);
    const setUpLocalProjectsLabel = generateLabel("Set up local projects", existingLabels);
    task["dependsOn"] = new CommentArray(createResourcesLabel, setUpLocalProjectsLabel);
    task["dependsOrder"] = "sequence";
    const createResources = createResourcesTask(createResourcesLabel);
    context.tasks.splice(index + 1, 0, createResources);
    const setUpLocalProjects = setUpLocalProjectsTask(setUpLocalProjectsLabel);
    context.tasks.splice(index + 2, 0, setUpLocalProjects);
    delete task["type"];
    delete task["command"];
    delete task["presentation"];

    break;
  }
}

export async function migrateNgrokStartTask(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      isCommentObject(task) &&
      ((typeof task["dependsOn"] === "string" && task["dependsOn"] === "teamsfx: ngrok start") ||
        (isCommentArray(task["dependsOn"]) && task["dependsOn"].includes("teamsfx: ngrok start")))
    ) {
      const newTask = generateLocalTunnelTask(context);
      context.tasks.splice(index + 1, 0, newTask);
      break;
    } else {
      ++index;
    }
  }
  replaceInDependsOn("teamsfx: ngrok start", context.tasks, TaskLabel.StartLocalTunnel);
}

export async function migrateNgrokStartCommand(context: DebugMigrationContext): Promise<void> {
  let index = 0;
  while (index < context.tasks.length) {
    const task = context.tasks[index];
    if (
      !isCommentObject(task) ||
      !(task["type"] === "teamsfx") ||
      !(task["command"] === "ngrok start")
    ) {
      ++index;
      continue;
    }

    const newTask = generateLocalTunnelTask(context, task);
    context.tasks.splice(index, 1, newTask);
    ++index;
  }
}

function generatePrerequisiteTask(
  task: CommentObject,
  context: DebugMigrationContext
): CommentObject {
  const comment = `{
    // Check if all required prerequisites are installed and will install them if not.
    // See https://aka.ms/teamsfx-check-prerequisites-task to know the details and how to customize the args.
  }`;
  const newTask: CommentObject = assign(parse(comment), task) as CommentObject;

  newTask["type"] = "teamsfx";
  newTask["command"] = "debug-check-prerequisites";

  const prerequisites = [
    `"${Prerequisite.nodejs}", // Validate if Node.js is installed.`,
    `"${Prerequisite.m365Account}", // Sign-in prompt for Microsoft 365 account, then validate if the account enables the sideloading permission.`,
    `"${Prerequisite.portOccupancy}", // Validate available ports to ensure those debug ones are not occupied.`,
  ];
  const prerequisitesComment = `
  [
    ${prerequisites.join("\n  ")}
  ]`;

  const ports: string[] = [];
  if (OldProjectSettingsHelper.includeTab(context.oldProjectSettings)) {
    ports.push(`${TaskDefaultValue.checkPrerequisites.ports.tabService}, // tab service port`);
  }
  if (OldProjectSettingsHelper.includeBot(context.oldProjectSettings)) {
    ports.push(`${TaskDefaultValue.checkPrerequisites.ports.botService}, // bot service port`);
    ports.push(
      `${TaskDefaultValue.checkPrerequisites.ports.botDebug}, // bot inspector port for Node.js debugger`
    );
  }
  if (OldProjectSettingsHelper.includeFunction(context.oldProjectSettings)) {
    ports.push(
      `${TaskDefaultValue.checkPrerequisites.ports.backendService}, // backend service port`
    );
    ports.push(
      `${TaskDefaultValue.checkPrerequisites.ports.backendDebug}, // backend inspector port for Node.js debugger`
    );
  }
  const portsComment = `
  [
    ${ports.join("\n  ")}
  ]
  `;

  const args: { [key: string]: CommentJSONValue } = {
    prerequisites: parse(prerequisitesComment),
    portOccupancy: parse(portsComment),
  };

  newTask["args"] = args as CommentJSONValue;
  return newTask;
}

function generateLocalTunnelTask(context: DebugMigrationContext, task?: CommentObject) {
  const comment = `{
      // Start the local tunnel service to forward public ngrok URL to local port and inspect traffic.
      // See https://aka.ms/teamsfx-local-tunnel-task for the detailed args definitions,
      // as well as samples to:
      //   - use your own ngrok command / configuration / binary
      //   - use your own tunnel solution
      //   - provide alternatives if ngrok does not work on your dev machine
    }`;
  const placeholderComment = `
    {
      // Keep consistency with migrated configuration.
    }
  `;
  const newTask = assign(task ?? parse(`{"label": "${TaskLabel.StartLocalTunnel}"}`), {
    type: "teamsfx",
    command: TaskCommand.startLocalTunnel,
    args: {
      ngrokArgs: TaskDefaultValue.startLocalTunnel.ngrokArgs,
      env: "local",
      output: assign(parse(placeholderComment), {
        endpoint: context.placeholderMapping.botEndpoint,
        domain: context.placeholderMapping.botDomain,
      }),
    },
    isBackground: true,
    problemMatcher: "$teamsfx-local-tunnel-watch",
  });
  return assign(parse(comment), newTask);
}

function handleProvisionAndDeploy(
  context: DebugMigrationContext,
  index: number,
  label: string
): number {
  context.tasks.splice(index, 1);

  const existingLabels = getLabels(context.tasks);

  const generatedBefore = context.generatedLabels.find((value) =>
    value.startsWith("Create resources")
  );
  const createResourcesLabel = generatedBefore || generateLabel("Create resources", existingLabels);

  const setUpLocalProjectsLabel =
    context.generatedLabels.find((value) => value.startsWith("Set up local projects")) ||
    generateLabel("Set up local projects", existingLabels);

  if (!generatedBefore) {
    context.generatedLabels.push(createResourcesLabel);
    const createResources = createResourcesTask(createResourcesLabel);
    context.tasks.splice(index, 0, createResources);
    ++index;

    context.generatedLabels.push(setUpLocalProjectsLabel);
    const setUpLocalProjects = setUpLocalProjectsTask(setUpLocalProjectsLabel);
    context.tasks.splice(index, 0, setUpLocalProjects);
    ++index;
  }

  replaceInDependsOn(label, context.tasks, createResourcesLabel, setUpLocalProjectsLabel);

  return index;
}

function replaceInDependsOn(
  label: string,
  tasks: CommentArray<CommentJSONValue>,
  ...replacements: string[]
): void {
  for (const task of tasks) {
    if (isCommentObject(task) && task["dependsOn"]) {
      if (typeof task["dependsOn"] === "string") {
        if (task["dependsOn"] === label) {
          if (replacements.length > 0) {
            task["dependsOn"] = new CommentArray(...replacements);
          } else {
            delete task["dependsOn"];
          }
        }
      } else if (Array.isArray(task["dependsOn"])) {
        const index = task["dependsOn"].findIndex((value) => value === label);
        if (index !== -1) {
          if (replacements.length > 0 && !task["dependsOn"].includes(replacements[0])) {
            task["dependsOn"].splice(index, 1, ...replacements);
          } else {
            task["dependsOn"].splice(index, 1);
          }
        }
      }
    }
  }
}

function getLabels(tasks: CommentArray<CommentJSONValue>): string[] {
  const labels: string[] = [];
  for (const task of tasks) {
    if (isCommentObject(task) && typeof task["label"] === "string") {
      labels.push(task["label"]);
    }
  }

  return labels;
}

function generateRunTabScript(context: DebugMigrationContext): string {
  const ssoSnippet = OldProjectSettingsHelper.includeSSO(context.oldProjectSettings)
    ? util.format(tabSSOSnippet, context.placeholderMapping.tabEndpoint)
    : "";
  const functionSnippet = OldProjectSettingsHelper.includeFunction(context.oldProjectSettings)
    ? util.format(
        tabFunctionSnippet,
        OldProjectSettingsHelper.getFunctionName(context.oldProjectSettings)
      )
    : "";
  return util.format(runTabScriptTemplate, ssoSnippet, functionSnippet);
}

function generateRunAuthScript(context: DebugMigrationContext): string {
  return util.format(
    runAuthScriptTemplate,
    context.placeholderMapping.tabDomain,
    context.placeholderMapping.tabEndpoint
  );
}

function generateRunBotScript(context: DebugMigrationContext): string {
  let ssoSnippet = "";
  if (OldProjectSettingsHelper.includeSSO(context.oldProjectSettings)) {
    if (OldProjectSettingsHelper.includeTab(context.oldProjectSettings)) {
      ssoSnippet = util.format(
        botSSOSnippet,
        context.placeholderMapping.botEndpoint,
        `\`api://\${envs.${context.placeholderMapping.tabDomain}}/botid-\${envs.BOT_ID}\`;`
      );
    } else {
      ssoSnippet = util.format(
        botSSOSnippet,
        context.placeholderMapping.botEndpoint,
        `\`api://botid-\${envs.BOT_ID}\`;`
      );
    }
  }
  const functionSnippet = OldProjectSettingsHelper.includeFunction(context.oldProjectSettings)
    ? botFunctionSnippet
    : "";
  const startSnippet =
    context.oldProjectSettings.programmingLanguage === "javascript"
      ? botStartJSSnippet
      : botStartTSSnippet;
  return util.format(runBotScriptTemplate, ssoSnippet, functionSnippet, startSnippet);
}

function generateRunBackendScript(context: DebugMigrationContext): string {
  const programmingLanguage = context.oldProjectSettings.programmingLanguage || "javascript";
  return util.format(runApiScriptTemplate, programmingLanguage);
}

const tabSSOSnippet = `
  process.env.REACT_APP_CLIENT_ID = envs.AAD_APP_CLIENT_ID;
  process.env.REACT_APP_START_LOGIN_PAGE_URL = \`\${envs.%s}/auth-start.html\`;
  process.env.REACT_APP_TEAMSFX_ENDPOINT = "https://localhost:55000";`;
const tabFunctionSnippet = `
  process.env.REACT_APP_FUNC_ENDPOINT = "http://localhost:7071";
  process.env.REACT_APP_FUNC_NAME = "%s";`;
const runTabScriptTemplate = `const cp = require("child_process");
const utils = require("@microsoft/teamsfx-run-utils");

// This script is used by Teams Toolkit to launch your service locally

async function run() {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    console.log(\`Usage: node \${__filename} [project path] [env path].\`);
    process.exit(1);
  }

  const envs = await utils.loadEnv(args[0], args[1]);

  // set up environment variables required by teamsfx
  process.env.BROWSER = "none";
  process.env.HTTPS = true;
  process.env.PORT = 53000;
  process.env.SSL_CRT_FILE = envs.SSL_CRT_FILE;
  process.env.SSL_KEY_FILE = envs.SSL_KEY_FILE;%s%s

  // launch service locally
  cp.spawn(/^win/.test(process.platform) ? "npx.cmd" : "npx", ["react-scripts", "start"], {
    stdio: "inherit",
  });
}

run();
`;

const runAuthScriptTemplate = `const cp = require("child_process");
const os = require("os");
const path = require("path");
const utils = require("@microsoft/teamsfx-run-utils");

// This script is used by Teams Toolkit to launch your service locally

async function run() {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    console.log(\`Usage: node \${__filename} [project path] [env path].\`);
    process.exit(1);
  }

  const envs = await utils.loadEnv(args[0], args[1]);

  // set up environment variables required by teamsfx
  process.env.CLIENT_ID = envs.CLIENT_ID;
  process.env.CLIENT_SECRET = envs.CLIENT_SECRET;
  process.env.IDENTIFIER_URI = \`api://\${envs.%s}/\${envs.CLIENT_ID}\`;
  process.env.AAD_METADATA_ADDRESS = \`\${envs.AAD_APP_OAUTH_AUTHORITY}/v2.0/.well-known/openid-configuration\`;
  process.env.OAUTH_AUTHORITY = envs.AAD_APP_OAUTH_AUTHORITY;
  process.env.TAB_APP_ENDPOINT = envs.%s;
  process.env.AUTH_ALLOWED_APP_IDS =
    "1fec8e78-bce4-4aaf-ab1b-5451cc387264;5e3ce6c0-2b1f-4285-8d4b-75ee78787346;0ec893e0-5785-4de6-99da-4ed124e5296c;4345a7b9-9a63-4910-a426-35363201d503;4765445b-32c6-49b0-83e6-1d93765276ca;d3590ed6-52b3-4102-aeff-aad2292ab01c;00000002-0000-0ff1-ce00-000000000000;bc59ab01-8403-45c6-8796-ac3ef710b3e3";
  process.env.urls = "http://localhost:55000";

  // launch service locally
  cp.spawn(envs.DOTNET_PATH, ["Microsoft.TeamsFx.SimpleAuth.dll"], {
    cwd: path.join(os.homedir(), ".fx", "localauth"),
    stdio: "inherit",
  });
}

run();
`;

const botSSOSnippet = `
  process.env.M365_CLIENT_ID = envs.AAD_APP_CLIENT_ID;
  process.env.M365_CLIENT_SECRET = envs.SECRET_AAD_APP_CLIENT_SECRET;
  process.env.M365_TENANT_ID = envs.AAD_APP_TENANT_ID;
  process.env.M365_AUTHORITY_HOST = envs.AAD_APP_OAUTH_AUTHORITY_HOST;
  process.env.INITIATE_LOGIN_ENDPOINT = \`\${envs.%s}/auth-start.html\`;
  process.env.M365_APPLICATION_ID_URI = %s`;
const botFunctionSnippet = `
  process.env.API_ENDPOINT = "http://localhost:7071";`;
const botStartJSSnippet = `
  cp.spawn(
    /^win/.test(process.platform) ? "npx.cmd" : "npx",
    ["nodemon", "--inspect=9239", "--signal", "SIGINT", "index.js"],
    { stdio: "inherit" }
  );`;
const botStartTSSnippet = `
  cp.spawn(
    /^win/.test(process.platform) ? "npx.cmd" : "npx",
    [
      "nodemon",
      "--exec",
      "node",
      "--inspect=9239",
      "--signal",
      "SIGINT",
      "-r",
      "ts-node/register",
      "index.ts",
    ],
    { stdio: "inherit" }
  );`;
const runBotScriptTemplate = `const cp = require("child_process");
const utils = require("@microsoft/teamsfx-run-utils");

// This script is used by Teams Toolkit to launch your service locally

async function run() {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    console.log(\`Usage: node \${__filename} [project path] [env path].\`);
    process.exit(1);
  }

  const envs = await utils.loadEnv(args[0], args[1]);

  // set up environment variables required by teamsfx
  process.env.BOT_ID = envs.BOT_ID;
  process.env.BOT_PASSWORD = envs.SECRET_BOT_PASSWORD;%s%s

  // launch service locally%s
}

run();
`;

const runApiScriptTemplate = `const cp = require("child_process");
const utils = require("@microsoft/teamsfx-run-utils");

// This script is used by Teams Toolkit to launch your service locally

async function run() {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    console.log(\`Usage: node \${__filename} [project path] [env path].\`);
    process.exit(1);
  }

  const envs = await utils.loadEnv(args[0], args[1]);

  // set up environment variables required by teamsfx
  process.env.FUNCTIONS_WORKER_RUNTIME = "node";
  process.env.M365_CLIENT_ID = envs.AAD_APP_CLIENT_ID;
  process.env.M365_CLIENT_SECRET = envs.SECRET_AAD_APP_CLIENT_SECRET;
  process.env.M365_TENANT_ID = envs.AAD_APP_TENANT_ID;
  process.env.M365_AUTHORITY_HOST = envs.AAD_APP_OAUTH_AUTHORITY_HOST;
  process.env.ALLOWED_APP_IDS =
    "1fec8e78-bce4-4aaf-ab1b-5451cc387264;5e3ce6c0-2b1f-4285-8d4b-75ee78787346;0ec893e0-5785-4de6-99da-4ed124e5296c;4345a7b9-9a63-4910-a426-35363201d503;4765445b-32c6-49b0-83e6-1d93765276ca;d3590ed6-52b3-4102-aeff-aad2292ab01c;00000002-0000-0ff1-ce00-000000000000;bc59ab01-8403-45c6-8796-ac3ef710b3e3";

  // launch service locally
  cp.spawn(
    "func",
    [
      "start",
      "--%s",
      '--language-worker="--inspect=9229"',
      "--port",
      '"7071"',
      "--cors",
      '"*"',
    ],
    {
      stdio: "inherit",
    }
  );
}

run();
`;