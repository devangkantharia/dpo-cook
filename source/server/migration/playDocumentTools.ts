/**
 * 3D Foundation Project
 * Copyright 2019 Smithsonian Institution
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as fs from "fs-extra";
import * as path from "path";
import * as deepEqual from "deep-equal";
import * as filenamify from "filenamify";
import * as THREE from "three";

import { Dictionary } from "@ff/core/types";

import { IDocument, INode, ICamera } from "../types/document";
import { ISetup, ITour, IState } from "../types/setup";
import { IArticle } from "../types/meta";
import { IModel, IAnnotation } from "../types/model";

import DocumentBuilder from "../utils/DocumentBuilder";

import { IPlayAnnotation, IPlayBoxInfo, IPlayContext, IPlaySnapshot, IPlayTour, IPlayTourComponent } from "./playTypes";

import { createModels } from "./playModelTools";
import { createArticle, fetchArticle } from "./playArticleTools";


////////////////////////////////////////////////////////////////////////////////

export async function createDocument(context: IPlayContext, info: IPlayBoxInfo): Promise<IDocument>
{
    const builder = new DocumentBuilder(context.job.jobDir);
    builder.document.asset.generator = "Cook - Play Migration";

    const scene = builder.getMainScene();
    const sceneSetup = builder.getOrCreateSetup(scene);

    // bookkeeping for HTML article conversion
    let articleIndex = 0;
    const articleByUrl: Dictionary<IArticle> = {};
    const tasks: Promise<unknown>[] = [];

    // determine annotation scale factor from scene dimensions
    const sceneBoundingBox = await createModels(context, info, builder.document);
    const size = new THREE.Vector3();
    sceneBoundingBox.getSize(size);
    const sceneRadius = size.length() * 0.5;
    const annotationScale = Math.max(size.x, size.y, size.z) / 25;

    // get first model
    const model = builder.document.models[0];
    const modelNode = builder.findNodesByModel(model)[0];

    // convert all annotations and assign to first model
    const playAnnotations = info.payload.message.annotations[0].annotations;
    console.log(`createDocument - converting ${playAnnotations.length} annotations`);

    playAnnotations.forEach(playAnnotation => {
        const annotation = builder.createAnnotation(model);
        convertAnnotation(playAnnotation, annotation);

        // adjust scale
        annotation.scale = annotationScale;

        // offset the annotation by the model's translation
        const p = annotation.position;
        const t = model.translation;
        p[0] += t[0]; p[1] += t[1]; p[2] += t[2];

        const articleUrl = playAnnotation.Link;
        if (articleUrl) {
            let article = articleByUrl[articleUrl];

            if (!article) {
                article = articleByUrl[articleUrl] = createArticle(context, articleIndex);
                tasks.push(fetchArticle(context, article, articleUrl, articleIndex++));
                builder.addArticle(modelNode, article);
            }

            annotation.articleId = article.id;
            annotation.style = "Extended";
        }
    });

    // convert scene settings (camera, etc.)
    convertScene(info, builder, sceneRadius);

    // tours
    const playTours = info.payload.message.tours;

    console.log(`createDocument - converting ${playTours.length} tours`);

    const tourTasks = playTours.map((tour, index) => findAnimatedTourProps(context, tour, index));
    await Promise.all(tourTasks);

    playTours.forEach((playTour, tourIndex) => {
        const tour = builder.createTour(sceneSetup, playTour.name);
        convertTour(playTour, tour);

        playTour.snapshots.forEach(playSnapshot => {
            const articleUrl = playSnapshot.data["Sidebar Store"]["Sidebar.URL"];
            let article: IArticle = null;

            if (articleUrl) {
                article = articleByUrl[articleUrl];
                if (!article) {
                    article = articleByUrl[articleUrl] = createArticle(context, articleIndex);
                    tasks.push(fetchArticle(context, article, articleUrl, articleIndex++));
                }

                builder.addArticle(scene, article);
            }

            const state = builder.createSnapshot(sceneSetup, tour, playSnapshot.name);
            const articleId = article ? article.id : "";
            convertSnapshot(playSnapshot, articleId, tour, state, sceneRadius);
        });
    });

    // default article, add to scene
    const articleUrl = info.config["Default Sidebar"].URL;
    if (articleUrl) {
        let article = articleByUrl[articleUrl];

        if (!article) {
            article = articleByUrl[articleUrl] = createArticle(context, articleIndex);
            tasks.push(fetchArticle(context, article, articleUrl, articleIndex++));
            builder.addArticle(scene, article);
        }
    }

    console.log(`createDocument - fetching ${tasks.length} articles`);

    return Promise.all(tasks)
        .then(() => builder.document);
}

function convertScene(info: IPlayBoxInfo, builder: DocumentBuilder, sceneRadius: number)
{
    const scene = builder.getMainScene();
    const meta = builder.getOrCreateMeta(scene);
    const setup = builder.getOrCreateSetup(scene);

    // set title of experience
    meta.collection = meta.collection || {};
    meta.collection["title"] = info.descriptor.name;

    // create camera
    let camera: ICamera = builder.getCamera(0);

    if (!camera) {
        const cameraNode = builder.createRootNode(scene);
        camera = builder.getOrCreateCamera(cameraNode);
    }

    camera.type = "perspective";
    camera.perspective = {
        yfov: 45,
        znear: 0.1,
        zfar: 100000
    };

    const cam = info.config["Camera - Curator Settings"];
    const offset = cam["Camera.Offset"];
    const distance = cam["Camera.Distance"];
    const orbitX = cam["Camera.Orientation.Y"];
    const orbitY = cam["Camera.Orientation.X"];

    const scaleFactor = sceneRadius / 8; // Play model scale to voyager model scale

    setup.navigation = {
        autoZoom: true,
        enabled: true,
        type: "Orbit",
        orbit: {
            offset: [ offset[0] * scaleFactor, offset[1] * scaleFactor, (offset[2] + distance) * scaleFactor ],
            orbit: [ orbitX, orbitY, 0 ],
            "minOrbit": [-90, null, null],
            "maxOrbit": [90, null, null],
            "minOffset": [null, null, 0.1],
            "maxOffset": [null, null, 10000]
        },
    };
}

function convertAnnotation(playAnnotation: IPlayAnnotation, annotation: IAnnotation)
{
    annotation.title = playAnnotation.Title;
    annotation.lead = playAnnotation.Body;

    if (annotation.lead) {
        annotation.style = "Extended";
    }

    annotation.color = playAnnotation["Stem.Color"];
    annotation.position = playAnnotation["Transform.Position"];

    const rotation = new THREE.Vector3();
    rotation.fromArray(playAnnotation["Transform.Rotation"]);
    rotation.multiplyScalar(THREE.Math.DEG2RAD);

    const euler = new THREE.Euler();
    euler.setFromVector3(rotation, "XYZ");

    const direction = new THREE.Vector3(0, 1, 0);
    direction.applyEuler(euler);

    annotation.direction = direction.toArray();
}

async function findAnimatedTourProps(context: IPlayContext, tour: IPlayTour, index: number)
{
    const snapshots = tour.snapshots;
    const first = snapshots[0];
    if (!first) {
        return Promise.resolve();
    }

    const firstStoreKeys = Object.keys(first.data);

    const components: Dictionary<Dictionary<boolean>> = {};

    for (let i = 1; i < snapshots.length; ++i) {
        const snapshot = snapshots[i];
        firstStoreKeys.forEach(storeKey => {
            const propKeys = Object.keys(first.data[storeKey]);
            propKeys.forEach(propKey => {
                if (!deepEqual(snapshot.data[storeKey][propKey], first.data[storeKey][propKey])) {
                    const props = components[storeKey] = components[storeKey] || {};
                    props[propKey] = true;
                }
            });
        });
    }

    console.log(`\n---------- TOUR: ${tour.name}: ANIMATED KEYS/PROPS ----------`);
    firstStoreKeys.forEach(storeKey => {
        if (components[storeKey]) {
            const animatedProps = Object.keys(components[storeKey]);
            if (animatedProps.length > 0) {
                console.log(storeKey);
                animatedProps.forEach(prop => console.log(`    ${prop}`));
            }
        }
    });

    const tourPropsFileName = `t${index}-${filenamify(tour.name)}-animated-props.json`;
    return fs.writeFile(path.resolve(context.job.jobDir, tourPropsFileName), JSON.stringify(components, null, 2));
}

function convertTour(playTour: IPlayTour, tour: ITour)
{
    tour.title = playTour.name;
    tour.lead = playTour.description;
}

const curves = [
    "Linear",         // 0
    "EaseQuad",       // 1
    "EaseInQuad",     // 2
    "EaseOutQuad",    // 3
    "EaseCubic",      // 4
    "EaseInCubic",    // 5
    "EaseOutCubic",   // 6
    "EaseQuart",      // 7
    "EaseInQuart",    // 8
    "EaseOutQuart",   // 9
    "EaseQuint",      // 10
    "EaseInQuint",    // 11
    "EaseOutQuint",   // 12
    "EaseSine",       // 13
    "EaseInSine",     // 14
    "EaseOutSine",    // 15
];

function convertSnapshot(playSnapshot: IPlaySnapshot, articleId, tour: ITour, state: IState, sceneRadius: number)
{
    state.duration = playSnapshot.transition.duration;
    state.threshold = playSnapshot.transition.switch;
    state.curve = curves[playSnapshot.transition.curve];

    const scaleFactor = sceneRadius / 8; // Play model scale to voyager model scale

    const camera = playSnapshot.data["Camera Store"];

    const orbit = [
        camera["Camera.Orientation"][1], // 1 = Pitch (X)
        camera["Camera.Orientation"][0], // 2 = Yaw (Y)
        camera["Camera.Orientation"][2], // 3 = Roll (Z)
    ];
    const offset = [
        camera["Camera.Offset"][0] * scaleFactor,
        camera["Camera.Offset"][1] * scaleFactor,
        (camera["Camera.Offset"][2] + camera["Camera.Distance"]) * scaleFactor,
    ];

    const readerEnabled = false;
    const annotationsVisible = false;
    const activeAnnotation = "";
    const activeTags = "";
    const shader = 0;
    const exposure = 1;

    state.values = [
        readerEnabled,
        articleId,
        orbit,
        offset,
        annotationsVisible,
        activeAnnotation,
        activeTags,
        shader,
        exposure,
    ];
}