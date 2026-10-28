import React from 'react';
import { Composition } from 'remotion';
import { Promo, DURATION, FPS } from './Promo';
export const Root: React.FC = () => (
  <Composition id="Promo" component={Promo} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} />
);
