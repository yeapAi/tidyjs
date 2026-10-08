// React
import React      from 'react';
import {useState} from 'react';
import type {FC}  from 'react';

// Shared
import {helper} from '@shared/helper';

export const Panel: FC<{ label: string }> = ({ label }) => {
    const [value] = useState(label);
    return <div title={helper(value)}>{React.version}</div>;
};
