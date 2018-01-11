import { S3 } from 'aws-sdk';
import * as fs from 'fs';
import * as cli from 'cli-color';
import * as path from 'path';
import * as url from 'url';
import * as jsdiff from 'diff';
import * as inquirer from 'inquirer';

import { Arguments } from 'yargs';
import { loadStackArgs, loadCFNTemplate, approvedTemplateVersionLocation } from '../cfn/index';
import configureAWS from '../configureAWS';
import { logger } from '../logger';

export async function request(argv: Arguments): Promise<number> {
    const stackArgs = await loadStackArgs(argv);

    if (typeof stackArgs.ApprovedTemplateLocation === "string" && stackArgs.ApprovedTemplateLocation.length > 0) {
        const s3 = new S3();

        await configureAWS(stackArgs.Profile, stackArgs.Region);
        const s3Args = await approvedTemplateVersionLocation(stackArgs.ApprovedTemplateLocation, stackArgs.Template, argv.argsfile);
        s3Args.Key = `${s3Args.Key}.pending`

        try {
            await s3.headObject(s3Args).promise();

            logSuccess(`👍 Your template has already been approved`);
        } catch (e) {
            if (e.code === "NotFound") {
                const cfnTemplate = await loadCFNTemplate(stackArgs.Template, argv.argsfile);
                await s3.putObject({
                    Body: cfnTemplate.TemplateBody,
                    ...s3Args
                }).promise();

                logSuccess(`Successfully uploaded the cloudformation template to ${stackArgs.ApprovedTemplateLocation}`);
                logSuccess(`Approve template with:\n  iidy template-approval review s3://${s3Args.Bucket}/${s3Args.Key}`);
            } else {
                throw new Error(e);
            }
        }

        return 0;
    } else {
        logError(`\`ApprovedTemplateLocation\` must be provided in ${argv.argsfile}`);
        return 1;
    }

}

export async function approveTemplate(argv: Arguments): Promise<number> {
    await configureAWS(argv.profile, 'us-east-1');
    const s3 = new S3();

    const s3Url = url.parse(argv.filename);
    const s3Path = s3Url.path ? s3Url.path.replace(/^\//, '') : '';
    const s3Bucket = s3Url.hostname ? s3Url.hostname : '';

    const bucketDir = path.parse(s3Path).dir;

    try {
        await s3.headObject({
            Bucket: s3Bucket,
            Key: s3Path.replace(/\.pending$/, '')
        }).promise();

        logSuccess(`👍 The template has already been approved`);
    } catch (e) {
        if (e.code === 'NotFound') {

            const pendingTemplate = await s3.getObject({
                Bucket: s3Bucket,
                Key: s3Path
            }).promise().then((template) => template.Body);

            const previouslyApprovedTemplate = await s3.getObject({
                Bucket: s3Bucket,
                Key: `${bucketDir}/latest`
            }).promise()
                .then((template) => template.Body)
                .catch((e) => {
                    if (e.code !== 'NoSuchKey') {
                        return Promise.reject(e);
                    }
                    return Buffer.from('');
                });

            const diff = jsdiff.diffLines(
                previouslyApprovedTemplate!.toString(),
                pendingTemplate!.toString(),
            );
            let colorizedString = '';

            diff.forEach(function(part) {
                if (part.added) {
                    colorizedString = colorizedString + cli.green(part.value);
                } else if (part.removed) {
                    colorizedString = colorizedString + cli.red(part.value);
                }
            });
            console.log(colorizedString);

            const resp = await inquirer.prompt(
                {
                    name: 'confirmed',
                    type: 'confirm', default: false,
                    message: `Do these changes look good for you?`
                });

            if (resp.confirmed) {
                // create a new pending file
                await s3.putObject({
                    Body: pendingTemplate,
                    Bucket: s3Bucket,
                    Key: s3Path.replace(/\.pending$/, '')
                }).promise();
                logDebug('Created a new cfn-template');

                // copy to latest
                await s3.putObject({
                    Body: pendingTemplate,
                    Bucket: s3Bucket,
                    Key: `${bucketDir}/latest`
                }).promise();
                logDebug('Updated latest');

                // delete the old pending file
                await s3.deleteObject({
                    Bucket: s3Bucket,
                    Key: s3Path
                }).promise();
                logDebug('Deleted pending file.');

                console.log();
                logSuccess(`Template has been successfully approved!`);
                return 0;
            } else {
                return 0;
            }

        } else {
            throw new Error(e);
        }
    }

    return 0;
}

function logSuccess(text: string) {
    logger.info(cli.green(text));
}

function logDebug(text: string) {
    logger.debug(text);
}

function logError(text: string) {
    logger.error(cli.red(text));
}
