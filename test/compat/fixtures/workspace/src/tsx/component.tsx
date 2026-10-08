import { helper } from '@shared/helper';
import React, { useMemo, useState, type FC } from 'react';
import { view } from '../app/feature/view';

export const Panel: FC<{ label: string }> = ({ label }) => {
    const [value] = useState(label);
    return <div title={helper(value)}>{React.version}</div>;
};
