// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  AppPackageFolderName,
  err,
  FxError,
  ok,
  ProjectSettings,
  SettingsFileName,
  SettingsFolderName,
  TemplateFolderName,
  SystemError,
  UserError,
} from "@microsoft/teamsfx-api";
import { Middleware, NextFunction } from "@feathersjs/hooks/lib";
import { CoreHookContext } from "../types";
import { MigrationContext, V2TeamsfxFolder } from "./utils/migrationContext";
import { checkMethod, checkUserTasks, outputCancelMessage, upgradeButton } from "./projectMigrator";
import * as path from "path";
import { loadProjectSettingsByProjectPathV2 } from "./projectSettingsLoader";
import {
  Component,
  ProjectMigratorStatus,
  sendTelemetryErrorEvent,
  sendTelemetryEvent,
  TelemetryEvent,
  TelemetryProperty,
} from "../../common/telemetry";
import { ErrorConstants } from "../../component/constants";
import { TOOLS } from "../globalVars";
import { getLocalizedString } from "../../common/localizeUtils";
import { UpgradeCanceledError } from "../error";
import { AppYmlGenerator } from "./utils/appYmlGenerator";
import * as fs from "fs-extra";
import { MANIFEST_TEMPLATE_CONSOLIDATE } from "../../component/resource/appManifest/constants";
import { replacePlaceholdersForV3, FileType } from "./MigrationUtils";
import { ReadFileError } from "../error";
import {
  fsReadDirSync,
  jsonObjectNamesConvertV3,
  readBicepContent,
  readStateFile,
} from "./utils/v3MigrationUtils";

const MigrationVersion = "2.1.0";
const Constants = {
  provisionBicepPath: "./templates/azure/provision.bicep",
  launchJsonPath: ".vscode/launch.json",
  appYmlName: "app.yml",
};

type Migration = (context: MigrationContext) => Promise<void>;
const subMigrations: Array<Migration> = [
  preMigration,
  generateSettingsJson,
  generateAppYml,
  replacePlaceholderForManifests,
  statesMigration,
  updateLaunchJson,
];

export const ProjectMigratorMWV3: Middleware = async (ctx: CoreHookContext, next: NextFunction) => {
  if ((await checkVersionForMigration(ctx)) && checkMethod(ctx)) {
    if (!checkUserTasks(ctx)) {
      ctx.result = ok(undefined);
      return;
    }
    if (!(await askUserConfirm(ctx))) {
      return;
    }
    const migrationContext = await MigrationContext.create(ctx);
    await wrapRunMigration(migrationContext, migrate);
    ctx.result = ok(undefined);
  } else {
    // continue next step only when:
    // 1. no need to upgrade the project;
    // 2. no need to update Teams Toolkit version;
    await next();
  }
};

export async function wrapRunMigration(
  context: MigrationContext,
  exec: (context: MigrationContext) => void
): Promise<void> {
  try {
    sendTelemetryEvent(Component.core, TelemetryEvent.ProjectMigratorMigrateStartV3);
    await exec(context);
    await showSummaryReport(context);
    sendTelemetryEvent(
      Component.core,
      TelemetryEvent.ProjectMigratorMigrateV3,
      context.telemetryProperties
    );
  } catch (error: any) {
    let fxError: FxError;
    if (error instanceof UserError || error instanceof SystemError) {
      fxError = error;
    } else {
      if (!(error instanceof Error)) {
        error = new Error(error.toString());
      }
      fxError = new SystemError({
        error,
        source: Component.core,
        name: ErrorConstants.unhandledError,
        message: error.message,
        displayMessage: error.message,
      });
    }
    sendTelemetryErrorEvent(
      Component.core,
      TelemetryEvent.ProjectMigratorV3Error,
      fxError,
      context.telemetryProperties
    );
    await rollbackMigration(context);
    throw error;
  }
}

async function rollbackMigration(context: MigrationContext): Promise<void> {
  await context.cleanModifiedPaths();
  await context.restoreBackup();
  await context.cleanTeamsfx();
}

//TODO: implement summaryReport
async function showSummaryReport(context: MigrationContext): Promise<void> {}

export async function migrate(context: MigrationContext): Promise<void> {
  for (const subMigration of subMigrations) {
    await subMigration(context);
  }
}

async function preMigration(context: MigrationContext): Promise<void> {
  await context.backup(V2TeamsfxFolder);
}

async function checkVersionForMigration(ctx: CoreHookContext): Promise<boolean> {
  const version = await getProjectVersion(ctx);
  return version === MigrationVersion;
}

// TODO: read the real version from project setting
async function getProjectVersion(ctx: CoreHookContext): Promise<string> {
  return "2.1.0";
}

export async function generateSettingsJson(context: MigrationContext): Promise<void> {
  const oldProjectSettings = await loadProjectSettings(context.projectPath);

  const content = {
    version: "3.0.0",
    trackingId: oldProjectSettings.projectId,
  };

  await context.fsEnsureDir(SettingsFolderName);
  await context.fsWriteFile(
    path.join(SettingsFolderName, SettingsFileName),
    JSON.stringify(content, null, 4)
  );
}

export async function generateAppYml(context: MigrationContext): Promise<void> {
  const bicepContent: string = await fs.readFile(
    path.join(context.projectPath, Constants.provisionBicepPath),
    "utf8"
  );
  const oldProjectSettings = await loadProjectSettings(context.projectPath);
  const appYmlGenerator = new AppYmlGenerator(oldProjectSettings, bicepContent);
  const appYmlString: string = await appYmlGenerator.generateAppYml();
  await context.fsWriteFile(path.join(SettingsFolderName, Constants.appYmlName), appYmlString);
}

export async function updateLaunchJson(context: MigrationContext): Promise<void> {
  const launchJsonPath = path.join(context.projectPath, Constants.launchJsonPath);
  if (await fs.pathExists(launchJsonPath)) {
    await context.backup(Constants.launchJsonPath);
    const launchJsonContent = await fs.readFile(launchJsonPath, "utf8");
    const result = launchJsonContent
      .replace(/\${teamsAppId}/g, "${dev:teamsAppId}") // TODO: set correct default env if user deletes dev, wait for other PR to get env list utility
      .replace(/\${localTeamsAppId}/g, "${local:teamsAppId}")
      .replace(/\${localTeamsAppInternalId}/g, "${local:teamsAppInternalId}"); // For M365 apps
    await context.fsWriteFile(Constants.launchJsonPath, result);
  }
}

async function loadProjectSettings(projectPath: string): Promise<ProjectSettings> {
  const oldProjectSettings = await loadProjectSettingsByProjectPathV2(projectPath, true);
  if (oldProjectSettings.isOk()) {
    return oldProjectSettings.value;
  } else {
    throw oldProjectSettings.error;
  }
}

export async function replacePlaceholderForManifests(context: MigrationContext): Promise<void> {
  // Backup templates/appPackage
  const oldAppPackageFolderPath = path.join(TemplateFolderName, AppPackageFolderName);
  const oldAppPackageFolderBackupRes = await context.backup(oldAppPackageFolderPath);

  if (!oldAppPackageFolderBackupRes) {
    // templates/appPackage does not exists
    // invalid teamsfx project
    throw ReadFileError(new Error("templates/appPackage does not exist"));
  }

  // Ensure appPackage
  await context.fsEnsureDir(AppPackageFolderName);

  // Copy templates/appPackage/resources
  const oldResourceFolderPath = path.join(oldAppPackageFolderPath, "resources");
  const oldResourceFolderExists = await fs.pathExists(
    path.join(context.projectPath, oldResourceFolderPath)
  );
  if (oldResourceFolderExists) {
    const resourceFolderPath = path.join(AppPackageFolderName, "resources");
    await context.fsCopy(oldResourceFolderPath, resourceFolderPath);
  }

  // Read Bicep
  const oldBicepFilePath = path.join(TemplateFolderName, "azure", "provision.bicep");
  const oldBicepFileExists = await fs.pathExists(path.join(context.projectPath, oldBicepFilePath));
  if (!oldBicepFileExists) {
    // templates/azure/provision.bicep does not exist
    throw ReadFileError(new Error("templates/azure/provision.bicep does not exist"));
  }
  const bicepContent = await fs.readFile(path.join(context.projectPath, oldBicepFilePath), "utf-8");

  // Read Teams app manifest and save to templates/appPackage/manifest.template.json
  const oldManifestPath = path.join(oldAppPackageFolderPath, MANIFEST_TEMPLATE_CONSOLIDATE);
  const oldManifestExists = await fs.pathExists(path.join(context.projectPath, oldManifestPath));
  if (oldManifestExists) {
    const manifestPath = path.join(AppPackageFolderName, MANIFEST_TEMPLATE_CONSOLIDATE);
    const oldManifest = await fs.readFile(path.join(context.projectPath, oldManifestPath), "utf8");
    const manifest = replacePlaceholdersForV3(oldManifest, bicepContent);
    // TODO: update app id uri
    await context.fsWriteFile(manifestPath, manifest);
  } else {
    // templates/appPackage/manifest.template.json does not exist
    throw ReadFileError(new Error("templates/appPackage/manifest.template.json does not exist"));
  }

  // Read AAD app manifest and save to ./aad.manifest.template.json
  const oldAadManifestPath = path.join(oldAppPackageFolderPath, "aad.template.json");
  const oldAadManifestExists = await fs.pathExists(
    path.join(context.projectPath, oldAadManifestPath)
  );
  if (oldAadManifestExists) {
    const oldAadManifest = await fs.readFile(
      path.join(context.projectPath, oldAadManifestPath),
      "utf-8"
    );
    const aadManifest = replacePlaceholdersForV3(oldAadManifest, bicepContent);
    // TODO: update app id uri
    await context.fsWriteFile("aad.manifest.template.json", aadManifest);
  }
}

export async function statesMigration(context: MigrationContext): Promise<void> {
  // general
  if (await context.fsPathExists(path.join(".fx", "states"))) {
    // if ./fx/states/ exists
    const fileNames = fsReadDirSync(context, path.join(".fx", "states")); // search all files, get file names
    for (const fileName of fileNames) {
      const fileRegex = new RegExp("(state\\.)([a-zA-Z0-9_]*)(\\.json)", "g"); // state.*.json
      const fileNamesArray = fileRegex.exec(fileName);
      if (fileNamesArray != null) {
        // get envName
        const envName = fileNamesArray[2];
        // create .env.{env} file
        await context.fsEnsureDir(SettingsFolderName);
        await context.fsCreateFile(path.join(SettingsFolderName, ".env." + envName));
        const obj = await readStateFile(
          context,
          path.join(".fx", "states", "state." + envName + ".json")
        );
        if (obj) {
          const bicepContent = readBicepContent(context);
          // convert every name
          const envData = jsonObjectNamesConvertV3(obj, "state.", FileType.STATE, bicepContent);
          await context.fsWriteFile(path.join(SettingsFolderName, ".env." + envName), envData);
        }
      }
    }
  }
}

export async function askUserConfirm(ctx: CoreHookContext): Promise<boolean> {
  sendTelemetryEvent(Component.core, TelemetryEvent.ProjectMigratorNotificationStart);
  const res = await TOOLS?.ui.showMessage(
    "warn",
    getLocalizedString("core.migrationV3.Message"),
    true,
    upgradeButton
  );
  const answer = res?.isOk() ? res.value : undefined;
  if (!answer || answer != upgradeButton) {
    sendTelemetryEvent(Component.core, TelemetryEvent.ProjectMigratorNotification, {
      [TelemetryProperty.Status]: ProjectMigratorStatus.Cancel,
    });
    ctx.result = err(UpgradeCanceledError());
    outputCancelMessage(ctx, true);
    return false;
  }
  sendTelemetryEvent(Component.core, TelemetryEvent.ProjectMigratorNotification, {
    [TelemetryProperty.Status]: ProjectMigratorStatus.OK,
  });
  return true;
}
